import { describe, expect, it } from "vitest";
import { PrismaDocumentTagRepository } from "./PrismaDocumentTagRepository";
import type { PrismaClient } from "@prisma/client";
import { TAG_LIMITS as L } from "@/src/domain/entities/Tag";

/**
 * Row-backed stand-in for the `documentTag` delegate.
 *
 * The fake enforces the real (documentId, tagId) unique constraint — a predicate
 * the adapter forgets to send simply does not filter, so the tests exercise the
 * adapter's actual Workspace scoping and idempotent-assign lookup.
 */
interface Row {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  tagId: string;
  assignedById: string;
  createdAt: Date;
}

function matchValue(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !(expected instanceof Date)) {
    const ops = expected as { in?: string[] };
    if ("in" in ops) return Array.isArray(ops.in) && ops.in.includes(actual as string);
    return false;
  }
  return actual === expected;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => matchValue(row[key as keyof Row], value));
}

function uniqueViolation(): Error {
  const error = new Error("Unique constraint failed on the fields: (`documentId`,`tagId`)");
  (error as Error & { code: string }).code = "P2002";
  return error;
}

function fakePrisma(rows: Row[]) {
  let seq = 0;

  const delegate = {
    async findFirst({ where }: { where: Record<string, unknown> }) {
      return rows.find((r) => matches(r, where)) ?? null;
    },
    async findMany({
      where,
      orderBy,
      take,
    }: {
      where: Record<string, unknown>;
      orderBy?: { documentId: "asc" };
      take?: number;
    }) {
      const found = rows.filter((r) => matches(r, where));
      if (orderBy?.documentId === "asc") found.sort((a, b) => a.documentId.localeCompare(b.documentId));
      return take === undefined ? found : found.slice(0, take);
    },
    async create({ data }: { data: Partial<Row> }) {
      if (rows.some((r) => r.documentId === data.documentId && r.tagId === data.tagId)) {
        throw uniqueViolation();
      }
      seq += 1;
      const created: Row = {
        id: `doc-tag-${seq}`,
        organizationId: data.organizationId!,
        workspaceId: data.workspaceId!,
        documentId: data.documentId!,
        tagId: data.tagId!,
        assignedById: data.assignedById!,
        createdAt: data.createdAt ?? new Date("2026-08-01T00:00:00.000Z"),
      };
      rows.push(created);
      return created;
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

  return { rows, documentTag: delegate };
}

function repo(rows: Row[] = []) {
  const prisma = fakePrisma(rows);
  return {
    prisma,
    subject: new PrismaDocumentTagRepository(prisma as unknown as PrismaClient),
  };
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "dt-seed",
    organizationId: "org-a",
    workspaceId: "ws-a",
    documentId: "doc-1",
    tagId: "tag-1",
    assignedById: "user-1",
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function assignInput(overrides: Partial<Parameters<ReturnType<typeof repo>["subject"]["assign"]>[0]> = {}) {
  return {
    organizationId: "org-a",
    workspaceId: "ws-a",
    documentId: "doc-1",
    tagId: "tag-1",
    assignedById: "user-1",
    ...overrides,
  };
}

describe("PrismaDocumentTagRepository", () => {
  it("assigns a tag to a document as a real row", async () => {
    const { subject, prisma } = repo();
    const assignment = await subject.assign(assignInput());

    expect(assignment.documentId).toBe("doc-1");
    expect(assignment.tagId).toBe("tag-1");
    expect(prisma.rows).toHaveLength(1);
  });

  it("returns the existing pair on a repeated assignment instead of duplicating", async () => {
    const { subject, prisma } = repo([row()]);
    const assignment = await subject.assign(assignInput());

    expect(assignment.id).toBe("dt-seed");
    expect(prisma.rows).toHaveLength(1);
  });

  it("does not resolve a pair that lives in another Workspace", async () => {
    const { subject } = repo([row({ workspaceId: "ws-b" })]);
    // The row exists, but addressing it through ws-a must find nothing: the
    // Workspace is part of every predicate, so an id alone never authorizes.
    expect(await subject.isAssigned("ws-a", "doc-1", "tag-1")).toBe(false);
    expect(await subject.remove("ws-a", "doc-1", "tag-1")).toBe(false);
    expect(await subject.listForDocument("ws-a", "doc-1")).toEqual([]);
  });

  it("removes an assignment idempotently and scoped to the Workspace", async () => {
    const { subject, prisma } = repo([row()]);
    expect(await subject.remove("ws-a", "doc-1", "tag-1")).toBe(true);
    expect(await subject.remove("ws-a", "doc-1", "tag-1")).toBe(false);
    expect(prisma.rows).toHaveLength(0);
  });

  it("answers isAssigned within the Workspace", async () => {
    const { subject } = repo([row()]);
    expect(await subject.isAssigned("ws-a", "doc-1", "tag-1")).toBe(true);
    expect(await subject.isAssigned("ws-b", "doc-1", "tag-1")).toBe(false);
  });

  it("lists a document's assignments bounded by the per-document cap", async () => {
    const { subject } = repo([
      row({ id: "d1", documentId: "doc-1", tagId: "tag-1" }),
      row({ id: "d2", documentId: "doc-1", tagId: "tag-2" }),
      row({ id: "d3", documentId: "doc-2", tagId: "tag-1" }),
    ]);

    const listed = await subject.listForDocument("ws-a", "doc-1");
    expect(listed.map((a) => a.tagId).sort()).toEqual(["tag-1", "tag-2"]);
  });

  it("finds documents carrying every named tag", async () => {
    const { subject } = repo([
      row({ id: "d1", documentId: "doc-both", tagId: "tag-1" }),
      row({ id: "d2", documentId: "doc-both", tagId: "tag-2" }),
      row({ id: "d3", documentId: "doc-one", tagId: "tag-1" }),
      row({ id: "d4", documentId: "doc-other-ws", tagId: "tag-1", workspaceId: "ws-b" }),
    ]);

    const both = await subject.listDocumentIdsWithAllTags("ws-a", ["tag-1", "tag-2"], 10);
    expect(both).toEqual(["doc-both"]);

    const single = await subject.listDocumentIdsWithAllTags("ws-a", ["tag-1"], 10);
    expect(single).toContain("doc-both");
    expect(single).toContain("doc-one");
    expect(single).not.toContain("doc-other-ws");
  });

  it("returns nothing for an empty tag set and bounds the result", async () => {
    const { subject } = repo([row()]);
    expect(await subject.listDocumentIdsWithAllTags("ws-a", [], 10)).toEqual([]);
    expect(await subject.listDocumentIdsWithAllTags("ws-a", ["tag-1"], 1)).toHaveLength(1);
  });

  it("lists assignments for many documents within the Workspace", async () => {
    const { subject } = repo([
      row({ id: "d1", documentId: "doc-1", tagId: "tag-1" }),
      row({ id: "d2", documentId: "doc-1", tagId: "tag-2" }),
      row({ id: "d3", documentId: "doc-2", tagId: "tag-1" }),
      row({ id: "d4", documentId: "doc-3", tagId: "tag-1", workspaceId: "ws-b" }),
    ]);

    const listed = await subject.listForDocuments("ws-a", ["doc-1", "doc-2", "doc-3"]);
    expect(listed.map((a) => a.documentId).sort()).toEqual(["doc-1", "doc-1", "doc-2"]);
  });

  it("counts per tag and per document within the Workspace", async () => {
    const { subject } = repo([
      row({ id: "d1", documentId: "doc-1", tagId: "tag-1" }),
      row({ id: "d2", documentId: "doc-2", tagId: "tag-1" }),
      row({ id: "d3", documentId: "doc-2", tagId: "tag-2" }),
      row({ id: "d4", documentId: "doc-3", tagId: "tag-1", workspaceId: "ws-b" }),
    ]);

    expect(await subject.countForTag("ws-a", "tag-1")).toBe(2);
    expect(await subject.countForDocument("ws-a", "doc-2")).toBe(2);
  });

  it("removes every assignment to a tag, scoped to the Workspace", async () => {
    const { subject, prisma } = repo([
      row({ id: "d1", documentId: "doc-1", tagId: "tag-1" }),
      row({ id: "d2", documentId: "doc-2", tagId: "tag-1" }),
      row({ id: "d3", documentId: "doc-1", tagId: "tag-1", workspaceId: "ws-b" }),
    ]);

    expect(await subject.removeAllForTag("ws-a", "tag-1")).toBe(2);
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0].workspaceId).toBe("ws-b");
  });

  it("binds a document's assignment listing to the per-document cap", async () => {
    const { subject } = repo(
      Array.from({ length: L.maxTagsPerDocument + 10 }, (_, index) =>
        row({ id: `d-${index}`, documentId: "doc-1", tagId: `tag-${index}` }),
      ),
    );

    const listed = await subject.listForDocument("ws-a", "doc-1");
    expect(listed.length).toBeLessThanOrEqual(L.maxTagsPerDocument);
  });
});
