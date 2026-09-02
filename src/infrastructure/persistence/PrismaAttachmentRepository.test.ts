import { describe, expect, it } from "vitest";
import { PrismaAttachmentRepository } from "./PrismaAttachmentRepository";
import type { PrismaClient } from "@prisma/client";
import { METADATA_LIMITS } from "@/src/domain/entities/DocumentMetadata";
import type { CreateAttachmentInput } from "@/src/application/ports/workspaces/AttachmentRepository";

interface AttachmentRow {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  storedFileId: string | null;
  origin: string;
  name: string;
  normalizedName: string;
  description: string | null;
  mimeType: string;
  byteSize: number;
  checksum: string;
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

function matches(row: AttachmentRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => matchValue(row[k as keyof AttachmentRow], v));
}

/** The migration's real unique index: (documentId, normalizedName). */
function uniqueViolation(): Error {
  const error = new Error(
    "Unique constraint failed on the fields: (`documentId`,`normalizedName`)",
  );
  (error as Error & { code: string }).code = "P2002";
  return error;
}

function fakePrisma(rows: AttachmentRow[]) {
  let seq = 0;
  const wheres: Record<string, unknown>[] = [];
  const record = <T extends Record<string, unknown>>(w: T): T => { wheres.push(w); return w; };

  const delegate = {
    async create({ data }: { data: Partial<AttachmentRow> }) {
      // The constraint is enforced here, not by a prior read: a check-then-insert
      // loses the race between two concurrent uploads of the same filename, and
      // the index is the only thing that actually serializes them.
      if (
        rows.some(
          (r) => r.documentId === data.documentId && r.normalizedName === data.normalizedName,
        )
      ) {
        throw uniqueViolation();
      }
      seq += 1;
      const now = new Date();
      const row: AttachmentRow = {
        id: `att-${seq}`,
        organizationId: data.organizationId!,
        workspaceId: data.workspaceId!,
        documentId: data.documentId!,
        storedFileId: data.storedFileId ?? null,
        origin: data.origin ?? "workspace",
        name: data.name!,
        normalizedName: data.normalizedName!,
        description: data.description ?? null,
        mimeType: data.mimeType ?? "application/octet-stream",
        byteSize: data.byteSize ?? 0,
        checksum: data.checksum ?? "",
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
              const av = a[key as keyof AttachmentRow] as string;
              const bv = b[key as keyof AttachmentRow] as string;
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
          ...(data.name !== undefined ? { name: data.name as string } : {}),
          ...(data.normalizedName !== undefined
            ? { normalizedName: data.normalizedName as string }
            : {}),
          ...(data.description !== undefined
            ? { description: data.description as string | null }
            : {}),
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
    async aggregate({ where }: { where: Record<string, unknown>; _sum?: unknown }) {
      record(where);
      const matched = rows.filter((r) => matches(r, where));
      if (matched.length === 0) return { _sum: { byteSize: null } };
      return { _sum: { byteSize: matched.reduce((total, r) => total + r.byteSize, 0) } };
    },
  };
  return { attachmentRecord: delegate, rows, wheres };
}

function repo(rows: AttachmentRow[] = []) {
  const prisma = fakePrisma(rows);
  return {
    prisma,
    rows: prisma.rows,
    subject: new PrismaAttachmentRepository(prisma as unknown as PrismaClient),
  };
}

function seedRow(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: "att-seed",
    organizationId: "org-a",
    workspaceId: "ws-a",
    documentId: "doc-1",
    storedFileId: "file-1",
    origin: "workspace",
    name: "Budget.xlsx",
    normalizedName: "budget.xlsx",
    description: null,
    mimeType: "application/vnd.ms-excel",
    byteSize: 2048,
    checksum: "a".repeat(64),
    createdById: "user-1",
    revision: 1,
    createdAt: new Date("2026-08-01T09:00:00.000Z"),
    updatedAt: new Date("2026-08-01T09:00:00.000Z"),
    ...overrides,
  };
}

function createInput(overrides: Partial<CreateAttachmentInput> = {}): CreateAttachmentInput {
  return {
    organizationId: "org-a",
    workspaceId: "ws-a",
    documentId: "doc-1",
    storedFileId: "file-1",
    origin: "workspace",
    name: "Budget.xlsx",
    normalizedName: "budget.xlsx",
    description: null,
    mimeType: "application/vnd.ms-excel",
    byteSize: 2048,
    checksum: "a".repeat(64),
    createdById: "user-1",
    ...overrides,
  };
}

describe("PrismaAttachmentRepository — create", () => {
  it("creates an attachment record", async () => {
    const { subject, rows } = repo();
    const attachment = await subject.create(createInput());

    expect(rows).toHaveLength(1);
    expect(attachment.name).toBe("Budget.xlsx");
    expect(attachment.byteSize).toBe(2048);
    expect(attachment.revision).toBe(1);
  });

  it("round-trips a workspace origin", async () => {
    const { subject } = repo();

    expect((await subject.create(createInput({ origin: "workspace" }))).origin).toBe("workspace");
  });

  it("round-trips an embedded origin", async () => {
    const { subject } = repo();
    const embedded = await subject.create(
      createInput({ origin: "embedded", storedFileId: null, normalizedName: "inner.pdf", name: "Inner.pdf" }),
    );

    expect(embedded.origin).toBe("embedded");
  });

  it("accepts a null storedFileId for an unextracted embedded attachment", async () => {
    const { subject } = repo();
    const embedded = await subject.create(createInput({ origin: "embedded", storedFileId: null }));

    // Honest state: catalogued from an inspection, listable, not downloadable.
    expect(embedded.storedFileId).toBeNull();
  });

  it("retains storedFileId for a workspace attachment", async () => {
    const { subject } = repo();

    expect((await subject.create(createInput({ storedFileId: "file-9" }))).storedFileId).toBe("file-9");
  });
});

describe("PrismaAttachmentRepository — name uniqueness", () => {
  it("scopes normalized-name uniqueness to the document", async () => {
    const { subject } = repo([seedRow({ id: "a1", documentId: "doc-1" })]);
    const found = await subject.getByNormalizedName("ws-a", "doc-1", "budget.xlsx");

    expect(found?.id).toBe("a1");
  });

  it("allows the same normalized name on another document", async () => {
    const { subject, rows } = repo([seedRow({ id: "a1", documentId: "doc-1" })]);
    await subject.create(createInput({ documentId: "doc-2" }));

    expect(rows).toHaveLength(2);
  });

  it("rejects a duplicate normalized name on the same document at the constraint", async () => {
    const { subject } = repo([seedRow({ documentId: "doc-1", normalizedName: "budget.xlsx" })]);

    // Enforced by the index rather than by a prior read, so two concurrent
    // uploads of the same filename cannot both succeed.
    await expect(subject.create(createInput({ documentId: "doc-1" }))).rejects.toThrow(
      /Unique constraint failed/u,
    );
  });

  it("does not resolve a name lookup across workspaces", async () => {
    const { subject } = repo([seedRow({ workspaceId: "ws-b" })]);

    expect(await subject.getByNormalizedName("ws-a", "doc-1", "budget.xlsx")).toBeNull();
  });
});

describe("PrismaAttachmentRepository — reads", () => {
  it("getById is workspace scoped", async () => {
    const { subject } = repo([seedRow()]);

    expect((await subject.getById("ws-a", "att-seed"))?.id).toBe("att-seed");
  });

  it("does not return another workspace's attachment", async () => {
    const { subject } = repo([seedRow({ workspaceId: "ws-b" })]);

    // The id is also the handle used to stream bytes, so a leak here is a leak of
    // the payload, not just of the row.
    expect(await subject.getById("ws-a", "att-seed")).toBeNull();
  });

  it("list is document scoped", async () => {
    const { subject } = repo([
      seedRow({ id: "a1", documentId: "doc-1", normalizedName: "a.txt" }),
      seedRow({ id: "a2", documentId: "doc-2", normalizedName: "b.txt" }),
    ]);
    const found = await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 50 });

    expect(found.map((a) => a.id)).toEqual(["a1"]);
  });

  it("list is workspace scoped", async () => {
    const { subject } = repo([
      seedRow({ id: "a1", workspaceId: "ws-a", normalizedName: "a.txt" }),
      seedRow({ id: "a2", workspaceId: "ws-b", normalizedName: "b.txt" }),
    ]);
    const found = await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 50 });

    expect(found.map((a) => a.id)).toEqual(["a1"]);
  });

  it("bounds the listing at the domain limit", async () => {
    const rows = Array.from({ length: METADATA_LIMITS.maxListLimit + 10 }, (_, i) =>
      seedRow({ id: `a-${i}`, normalizedName: `f-${String(i).padStart(4, "0")}.txt` }),
    );
    const { subject } = repo(rows);
    const found = await subject.list({
      workspaceId: "ws-a",
      documentId: "doc-1",
      limit: METADATA_LIMITS.maxListLimit + 10,
    });

    expect(found.length).toBeLessThanOrEqual(METADATA_LIMITS.maxListLimit);
  });

  it("filters by origin", async () => {
    const { subject } = repo([
      seedRow({ id: "a-ws", origin: "workspace", normalizedName: "a.txt" }),
      seedRow({ id: "a-emb", origin: "embedded", normalizedName: "b.txt" }),
    ]);
    const embedded = await subject.list({
      workspaceId: "ws-a",
      documentId: "doc-1",
      origin: "embedded",
      limit: 50,
    });

    expect(embedded.map((a) => a.id)).toEqual(["a-emb"]);
  });
});

describe("PrismaAttachmentRepository — degraded stored values", () => {
  it("degrades an unknown stored origin to read-only embedded", async () => {
    const { subject } = repo([seedRow({ origin: "future-kind" })]);

    expect((await subject.getById("ws-a", "att-seed"))?.origin).toBe("embedded");
  });

  it("never returns a negative byte size", async () => {
    const { subject } = repo([seedRow({ byteSize: -500 })]);

    // A negative size would make a quota sum smaller than reality, which is the
    // direction that lets a document exceed its limit.
    expect((await subject.getById("ws-a", "att-seed"))?.byteSize).toBe(0);
  });

  it("bounds an oversized stored checksum", async () => {
    const { subject } = repo([seedRow({ checksum: "c".repeat(500) })]);
    const found = await subject.getById("ws-a", "att-seed");

    expect(found!.checksum.length).toBe(METADATA_LIMITS.maxChecksumLength);
  });

  it("bounds an oversized stored MIME type", async () => {
    const { subject } = repo([seedRow({ mimeType: `text/${"x".repeat(500)}` })]);
    const found = await subject.getById("ws-a", "att-seed");

    expect(found!.mimeType.length).toBe(METADATA_LIMITS.maxMimeTypeLength);
  });

  it("returns a name within the domain limit", async () => {
    const { subject } = repo([seedRow({ name: "n".repeat(METADATA_LIMITS.maxAttachmentNameLength) })]);
    const found = await subject.getById("ws-a", "att-seed");

    expect(found!.name.length).toBeLessThanOrEqual(METADATA_LIMITS.maxAttachmentNameLength);
  });

  it("returns a description within the domain limit", async () => {
    const { subject } = repo([
      seedRow({ description: "d".repeat(METADATA_LIMITS.maxDescriptionLength) }),
    ]);
    const found = await subject.getById("ws-a", "att-seed");

    expect(found!.description!.length).toBeLessThanOrEqual(METADATA_LIMITS.maxDescriptionLength);
  });

  it("normalizes a nonsensical stored revision", async () => {
    const { subject } = repo([seedRow({ revision: 0 })]);

    expect((await subject.getById("ws-a", "att-seed"))?.revision).toBe(1);
  });
});

describe("PrismaAttachmentRepository — optimistic update", () => {
  it("applies the update when the revision matches", async () => {
    const { subject } = repo([seedRow({ revision: 2 })]);
    const updated = await subject.update("ws-a", "att-seed", 2, {
      name: "Renamed.xlsx",
      normalizedName: "renamed.xlsx",
    });

    expect(updated?.name).toBe("Renamed.xlsx");
  });

  it("returns null on a stale revision", async () => {
    const { subject, rows } = repo([seedRow({ revision: 2 })]);

    expect(await subject.update("ws-a", "att-seed", 1, { name: "Lost.xlsx" })).toBeNull();
    expect(rows[0].name).toBe("Budget.xlsx");
  });

  it("increments the revision exactly once", async () => {
    const { subject } = repo([seedRow({ revision: 5 })]);

    expect((await subject.update("ws-a", "att-seed", 5, { description: "d" }))?.revision).toBe(6);
  });

  it("leaves createdAt unchanged", async () => {
    const created = new Date("2026-07-01T08:00:00.000Z");
    const { subject } = repo([seedRow({ createdAt: created, revision: 1 })]);
    const updated = await subject.update("ws-a", "att-seed", 1, { description: "d" });

    expect(updated?.createdAt.toISOString()).toBe(created.toISOString());
  });

  it("advances updatedAt", async () => {
    const stamp = new Date("2026-07-01T08:00:00.000Z");
    const { subject } = repo([seedRow({ updatedAt: stamp, revision: 1 })]);
    const updated = await subject.update("ws-a", "att-seed", 1, { description: "d" });

    expect(updated!.updatedAt.getTime()).toBeGreaterThan(stamp.getTime());
  });

  it("does not update another workspace's attachment", async () => {
    const { subject } = repo([seedRow({ workspaceId: "ws-b", revision: 1 })]);

    expect(await subject.update("ws-a", "att-seed", 1, { name: "Theirs.xlsx" })).toBeNull();
  });
});

describe("PrismaAttachmentRepository — deletion", () => {
  it("delete is workspace scoped", async () => {
    const { subject, rows } = repo([seedRow({ workspaceId: "ws-b" })]);

    expect(await subject.delete("ws-a", "att-seed")).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it("deletes within the workspace", async () => {
    const { subject, rows } = repo([seedRow()]);

    expect(await subject.delete("ws-a", "att-seed")).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("deleteForDocument affects only the target document", async () => {
    const { subject, rows } = repo([
      seedRow({ id: "a1", documentId: "doc-1", normalizedName: "a.txt" }),
      seedRow({ id: "a2", documentId: "doc-2", normalizedName: "b.txt" }),
    ]);

    expect(await subject.deleteForDocument("ws-a", "doc-1")).toBe(1);
    expect(rows.map((r) => r.id)).toEqual(["a2"]);
  });
});

describe("PrismaAttachmentRepository — counting and quota", () => {
  it("countForDocument is workspace scoped", async () => {
    const { subject } = repo([
      seedRow({ id: "a1", workspaceId: "ws-a", normalizedName: "a.txt" }),
      seedRow({ id: "a2", workspaceId: "ws-b", normalizedName: "b.txt" }),
    ]);

    expect(await subject.countForDocument("ws-a", "doc-1")).toBe(1);
  });

  it("totalBytesForDocument excludes another workspace and another document", async () => {
    const { subject } = repo([
      seedRow({ id: "a1", byteSize: 1000, normalizedName: "a.txt" }),
      seedRow({ id: "a2", byteSize: 2000, normalizedName: "b.txt" }),
      seedRow({ id: "a3", byteSize: 4000, workspaceId: "ws-b", normalizedName: "c.txt" }),
      seedRow({ id: "a4", byteSize: 8000, documentId: "doc-2", normalizedName: "d.txt" }),
    ]);

    expect(await subject.totalBytesForDocument("ws-a", "doc-1")).toBe(3000);
  });

  it("reports zero bytes for a document with no attachments", async () => {
    const { subject } = repo();

    // Falling back to zero rather than to the quota is the right direction: a
    // document with nothing attached has consumed nothing.
    expect(await subject.totalBytesForDocument("ws-a", "doc-1")).toBe(0);
  });
});

describe("PrismaAttachmentRepository — returned values are copies", () => {
  it("cannot mutate stored state through a returned record", async () => {
    const { subject, rows } = repo([seedRow()]);
    const found = await subject.getById("ws-a", "att-seed");
    found!.name = "Tampered.xlsx";
    found!.createdAt.setFullYear(1999);

    expect(rows[0].name).toBe("Budget.xlsx");
    expect(rows[0].createdAt.getUTCFullYear()).toBe(2026);
  });
});

describe("PrismaAttachmentRepository — tenant scoping", () => {
  it("carries workspaceId in every predicate", async () => {
    const { subject, prisma } = repo([seedRow({ revision: 1 })]);

    await subject.getById("ws-a", "att-seed");
    await subject.getByNormalizedName("ws-a", "doc-1", "budget.xlsx");
    await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 10 });
    await subject.update("ws-a", "att-seed", 1, { description: "d" });
    await subject.countForDocument("ws-a", "doc-1");
    await subject.totalBytesForDocument("ws-a", "doc-1");
    await subject.delete("ws-a", "att-seed");
    await subject.deleteForDocument("ws-a", "doc-1");

    expect(prisma.wheres.length).toBeGreaterThan(0);
    for (const where of prisma.wheres) {
      expect(where).toHaveProperty("workspaceId", "ws-a");
    }
  });
});
