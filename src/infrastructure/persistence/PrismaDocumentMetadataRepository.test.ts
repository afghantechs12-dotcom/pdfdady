import { describe, expect, it } from "vitest";
import { PrismaDocumentMetadataRepository } from "./PrismaDocumentMetadataRepository";
import type { PrismaClient } from "@prisma/client";
import { METADATA_LIMITS, serializeMetadataFields } from "@/src/domain/entities/DocumentMetadata";
import type { UpsertDocumentMetadataInput } from "@/src/application/ports/workspaces/DocumentMetadataRepository";

interface MetadataRow {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  fields: string;
  schemaVersion: number;
  createdById: string;
  updatedById: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

function applyIncrement(current: number, op: unknown): number {
  if (op !== null && typeof op === "object" && "increment" in op) {
    return current + (op as { increment: number }).increment;
  }
  return op as number;
}

function matchValue(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !(expected instanceof Date)) {
    const ops = expected as Record<string, unknown>;
    if ("in" in ops) return Array.isArray(ops.in) && (ops.in as unknown[]).includes(actual);
    return false;
  }
  return actual === expected;
}

function matches(row: MetadataRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => matchValue(row[k as keyof MetadataRow], v));
}

function fakePrisma(rows: MetadataRow[]) {
  let seq = 0;
  /**
   * Every predicate the adapter actually sent. Recorded rather than asserted
   * inline because the guarantee under test is a property of all of them: a
   * single read that forgets `workspaceId` is a cross-tenant disclosure, and it
   * would pass every behavioural test in this file.
   */
  const wheres: Record<string, unknown>[] = [];
  const record = <T extends Record<string, unknown>>(where: T): T => {
    wheres.push(where);
    return where;
  };
  const delegate = {
    async upsert({
      where,
      create,
      update,
    }: {
      where: { workspaceId_documentId: { workspaceId: string; documentId: string } };
      create: Partial<MetadataRow>;
      update: Partial<MetadataRow> & { revision?: unknown };
    }) {
      const { workspaceId, documentId } = where.workspaceId_documentId;
      record(where.workspaceId_documentId);
      const idx = rows.findIndex((r) => r.workspaceId === workspaceId && r.documentId === documentId);
      if (idx === -1) {
        seq += 1;
        const now = new Date();
        const row: MetadataRow = {
          id: `meta-${seq}`,
          organizationId: create.organizationId!,
          workspaceId: create.workspaceId!,
          documentId: create.documentId!,
          fields: (create.fields as string) ?? "{}",
          schemaVersion: create.schemaVersion ?? 1,
          createdById: create.createdById!,
          updatedById: create.updatedById!,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        rows.push(row);
        return row;
      }
      const existing = rows[idx];
      const now = new Date();
      const updated: MetadataRow = {
        ...existing,
        fields: (update.fields as string) ?? existing.fields,
        schemaVersion: (update.schemaVersion as number) ?? existing.schemaVersion,
        updatedById: (update.updatedById as string) ?? existing.updatedById,
        revision: applyIncrement(existing.revision, update.revision ?? existing.revision),
        updatedAt: now,
      };
      rows[idx] = updated;
      return updated;
    },
    async findUnique({
      where,
    }: {
      where: { workspaceId_documentId: { workspaceId: string; documentId: string } };
    }) {
      const { workspaceId, documentId } = where.workspaceId_documentId;
      record(where.workspaceId_documentId);
      return rows.find((r) => r.workspaceId === workspaceId && r.documentId === documentId) ?? null;
    },
    async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      record(where);
      const matched = rows.filter((r) => matches(r, where));
      const now = new Date();
      for (const row of matched) {
        const idx = rows.indexOf(row);
        rows[idx] = {
          ...row,
          fields: data.fields !== undefined ? (data.fields as string) : row.fields,
          schemaVersion: data.schemaVersion !== undefined ? (data.schemaVersion as number) : row.schemaVersion,
          updatedById: data.updatedById !== undefined ? (data.updatedById as string) : row.updatedById,
          revision: applyIncrement(row.revision, data.revision ?? row.revision),
          updatedAt: now,
        };
      }
      return { count: matched.length };
    },
    async findMany({ where }: { where: Record<string, unknown> }) {
      record(where);
      return rows.filter((r) => {
        return Object.entries(where).every(([k, v]) => matchValue(r[k as keyof MetadataRow], v));
      });
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
  return { documentMetadata: delegate, rows, wheres };
}

function repo(rows: MetadataRow[] = []) {
  const prisma = fakePrisma(rows);
  return {
    prisma,
    rows: prisma.rows,
    subject: new PrismaDocumentMetadataRepository(prisma as unknown as PrismaClient),
  };
}

function row(overrides: Partial<MetadataRow> = {}): MetadataRow {
  return {
    id: "meta-seed",
    organizationId: "org-a",
    workspaceId: "ws-a",
    documentId: "doc-1",
    fields: serializeMetadataFields({ title: "Quarterly report", author: "Dana" }),
    schemaVersion: METADATA_LIMITS.schemaVersion,
    createdById: "user-1",
    updatedById: "user-1",
    revision: 1,
    createdAt: new Date("2026-08-01T09:00:00.000Z"),
    updatedAt: new Date("2026-08-01T09:00:00.000Z"),
    ...overrides,
  };
}

function upsertInput(overrides: Partial<UpsertDocumentMetadataInput> = {}): UpsertDocumentMetadataInput {
  return {
    organizationId: "org-a",
    workspaceId: "ws-a",
    documentId: "doc-1",
    fields: { title: "Quarterly report" },
    schemaVersion: METADATA_LIMITS.schemaVersion,
    actorId: "user-1",
    ...overrides,
  };
}

describe("PrismaDocumentMetadataRepository — upsert convergence", () => {
  it("creates exactly one metadata row", async () => {
    const { subject, rows } = repo();
    const saved = await subject.upsert(upsertInput());

    expect(rows).toHaveLength(1);
    expect(saved.fields).toEqual({ title: "Quarterly report" });
    expect(saved.revision).toBe(1);
  });

  it("converges on the same row when the same document is saved again", async () => {
    const { subject, rows } = repo();
    await subject.upsert(upsertInput());
    const second = await subject.upsert(upsertInput({ fields: { title: "Revised report" } }));

    // A redelivered save must not produce a second set of properties: the
    // (workspaceId, documentId) unique index is what the adapter relies on.
    expect(rows).toHaveLength(1);
    expect(second.fields).toEqual({ title: "Revised report" });
  });

  it("keeps the same document id isolated across workspaces", async () => {
    const { subject, rows } = repo();
    await subject.upsert(upsertInput({ workspaceId: "ws-a", fields: { title: "Ours" } }));
    await subject.upsert(
      upsertInput({ workspaceId: "ws-b", organizationId: "org-b", fields: { title: "Theirs" } }),
    );

    expect(rows).toHaveLength(2);
    const ours = await subject.getByDocumentId("ws-a", "doc-1");
    expect(ours?.fields).toEqual({ title: "Ours" });
  });

  it("increments the revision exactly once per upsert", async () => {
    const { subject } = repo();
    await subject.upsert(upsertInput());
    const second = await subject.upsert(upsertInput());

    expect(second.revision).toBe(2);
  });

  it("records the acting user as the updater on a later save", async () => {
    const { subject } = repo();
    await subject.upsert(upsertInput({ actorId: "user-1" }));
    const second = await subject.upsert(upsertInput({ actorId: "user-2" }));

    expect(second.createdById).toBe("user-1");
    expect(second.updatedById).toBe("user-2");
  });
});

describe("PrismaDocumentMetadataRepository — reads", () => {
  it("returns the local workspace row", async () => {
    const { subject } = repo([row()]);
    const found = await subject.getByDocumentId("ws-a", "doc-1");

    expect(found?.documentId).toBe("doc-1");
    expect(found?.fields.author).toBe("Dana");
  });

  it("does not return another workspace's row", async () => {
    const { subject } = repo([row({ workspaceId: "ws-b" })]);

    expect(await subject.getByDocumentId("ws-a", "doc-1")).toBeNull();
  });

  it("parses serialized metadata on read", async () => {
    const { subject } = repo([
      row({ fields: serializeMetadataFields({ title: "Parsed", company: "Acme" }) }),
    ]);
    const found = await subject.getByDocumentId("ws-a", "doc-1");

    expect(found?.fields).toEqual({ title: "Parsed", company: "Acme" });
  });

  it("degrades safely when the stored JSON is invalid", async () => {
    const { subject } = repo([row({ fields: "{not json" })]);
    const found = await subject.getByDocumentId("ws-a", "doc-1");

    // A corrupt row must not make the properties panel unopenable.
    expect(found).not.toBeNull();
    expect(found?.fields).toEqual({});
  });

  it("drops unknown metadata keys held in a stored row", async () => {
    const { subject } = repo([
      row({ fields: JSON.stringify({ title: "Kept", injected: "dropped" }) }),
    ]);
    const found = await subject.getByDocumentId("ws-a", "doc-1");

    expect(found?.fields).toEqual({ title: "Kept" });
  });

  it("reports an unknown schema version rather than silently trusting it", async () => {
    const { subject } = repo([row({ schemaVersion: 99 })]);
    const found = await subject.getByDocumentId("ws-a", "doc-1");

    // The version is surfaced verbatim so a caller can degrade; the fields are
    // still parsed key-by-key against the current allowlist, so nothing a newer
    // build wrote can smuggle an unknown key through.
    expect(found?.schemaVersion).toBe(99);
    expect(Object.keys(found?.fields ?? {}).every((k) => k !== "injected")).toBe(true);
  });

  it("drops an oversized stored value rather than returning it", async () => {
    const oversized = "x".repeat(METADATA_LIMITS.maxValueLength + 1);
    const { subject } = repo([row({ fields: JSON.stringify({ title: oversized }) })]);
    const found = await subject.getByDocumentId("ws-a", "doc-1");

    expect(found?.fields.title).toBeUndefined();
  });

  it("normalizes a nonsensical stored revision to a usable one", async () => {
    const { subject } = repo([row({ revision: 0 })]);

    expect((await subject.getByDocumentId("ws-a", "doc-1"))?.revision).toBe(1);
  });
});

describe("PrismaDocumentMetadataRepository — bulk listing", () => {
  it("is scoped to the workspace", async () => {
    const { subject } = repo([
      row({ id: "m1", documentId: "doc-1" }),
      row({ id: "m2", documentId: "doc-2", workspaceId: "ws-b" }),
    ]);
    const found = await subject.listForDocuments("ws-a", ["doc-1", "doc-2"]);

    expect(found.map((m) => m.id)).toEqual(["m1"]);
  });

  it("returns nothing for an empty document list without querying", async () => {
    const { subject, prisma } = repo([row()]);
    const found = await subject.listForDocuments("ws-a", []);

    expect(found).toEqual([]);
    // An empty `in` list is a query that can only return nothing; sending it is
    // pure cost, and in some engines it is a syntax error.
    expect(prisma.wheres).toHaveLength(0);
  });

  it("bounds the document list it will query for", async () => {
    const { subject, prisma } = repo();
    const ids = Array.from({ length: METADATA_LIMITS.maxListLimit + 40 }, (_, i) => `doc-${i}`);
    await subject.listForDocuments("ws-a", ids);

    const sent = prisma.wheres[0]?.documentId as { in: string[] };
    expect(sent.in).toHaveLength(METADATA_LIMITS.maxListLimit);
  });
});

describe("PrismaDocumentMetadataRepository — compare-and-swap replace", () => {
  it("replaces the fields when the expected revision matches", async () => {
    const { subject } = repo([row({ revision: 3 })]);
    const updated = await subject.replaceFields("ws-a", "doc-1", 3, { title: "Swapped" }, "user-2");

    expect(updated?.fields).toEqual({ title: "Swapped" });
  });

  it("returns null on a stale revision", async () => {
    const { subject, rows } = repo([row({ revision: 3 })]);
    const updated = await subject.replaceFields("ws-a", "doc-1", 2, { title: "Lost" }, "user-2");

    expect(updated).toBeNull();
    expect(rows[0].revision).toBe(3);
  });

  it("returns null for a missing row, indistinguishably from a lost race", async () => {
    const { subject } = repo();
    const missing = await subject.replaceFields("ws-a", "doc-404", 1, {}, "user-2");
    const stale = await subject.replaceFields("ws-a", "doc-1", 9, {}, "user-2");

    // Both null: a caller must not be able to probe for a document's existence
    // by comparing a conflict against a not-found.
    expect(missing).toBeNull();
    expect(stale).toBeNull();
  });

  it("increments the revision exactly once", async () => {
    const { subject } = repo([row({ revision: 3 })]);
    const updated = await subject.replaceFields("ws-a", "doc-1", 3, { title: "Once" }, "user-2");

    expect(updated?.revision).toBe(4);
  });

  it("leaves createdAt unchanged", async () => {
    const created = new Date("2026-07-01T08:00:00.000Z");
    const { subject } = repo([row({ createdAt: created, revision: 1 })]);
    const updated = await subject.replaceFields("ws-a", "doc-1", 1, { title: "Kept" }, "user-2");

    expect(updated?.createdAt.toISOString()).toBe(created.toISOString());
  });

  it("advances updatedAt", async () => {
    const stamp = new Date("2026-07-01T08:00:00.000Z");
    const { subject } = repo([row({ createdAt: stamp, updatedAt: stamp, revision: 1 })]);
    const updated = await subject.replaceFields("ws-a", "doc-1", 1, { title: "Fresh" }, "user-2");

    expect(updated!.updatedAt.getTime()).toBeGreaterThan(stamp.getTime());
  });

  it("attributes the update to the acting user", async () => {
    const { subject } = repo([row({ updatedById: "user-1", revision: 1 })]);
    const updated = await subject.replaceFields("ws-a", "doc-1", 1, { title: "Mine" }, "user-9");

    expect(updated?.updatedById).toBe("user-9");
    expect(updated?.createdById).toBe("user-1");
  });

  it("does not replace another workspace's row", async () => {
    const { subject, rows } = repo([row({ workspaceId: "ws-b", revision: 1 })]);
    const updated = await subject.replaceFields("ws-a", "doc-1", 1, { title: "Theirs" }, "user-2");

    expect(updated).toBeNull();
    expect(rows[0].fields).toContain("Quarterly report");
  });
});

describe("PrismaDocumentMetadataRepository — delete and count", () => {
  it("deletes within the workspace", async () => {
    const { subject, rows } = repo([row()]);

    expect(await subject.delete("ws-a", "doc-1")).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("does not delete another workspace's row", async () => {
    const { subject, rows } = repo([row({ workspaceId: "ws-b" })]);

    expect(await subject.delete("ws-a", "doc-1")).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it("counts only rows in the workspace", async () => {
    const { subject } = repo([
      row({ id: "m1", documentId: "doc-1" }),
      row({ id: "m2", documentId: "doc-2" }),
      row({ id: "m3", documentId: "doc-3", workspaceId: "ws-b" }),
    ]);

    expect(await subject.countForWorkspace("ws-a")).toBe(2);
  });
});

describe("PrismaDocumentMetadataRepository — returned values are copies", () => {
  it("cannot mutate the stored serialized row through returned fields", async () => {
    const { subject, rows } = repo([row()]);
    const found = await subject.getByDocumentId("ws-a", "doc-1");
    found!.fields.title = "Tampered";

    // `fields` is reconstructed by the parser, so it is structurally unrelated
    // to the stored string — the mutation has nowhere to land.
    expect(rows[0].fields).toContain("Quarterly report");
    expect((await subject.getByDocumentId("ws-a", "doc-1"))?.fields.title).toBe("Quarterly report");
  });

  it("cannot mutate stored state through a returned Date", async () => {
    const created = new Date("2026-08-01T09:00:00.000Z");
    const { subject, rows } = repo([row({ createdAt: created })]);
    const found = await subject.getByDocumentId("ws-a", "doc-1");
    found!.createdAt.setFullYear(1999);

    expect(rows[0].createdAt.getUTCFullYear()).toBe(2026);
  });
});

describe("PrismaDocumentMetadataRepository — tenant scoping", () => {
  it("carries workspaceId in every id-based predicate", async () => {
    const { subject, prisma } = repo([row({ revision: 1 })]);

    await subject.getByDocumentId("ws-a", "doc-1");
    await subject.replaceFields("ws-a", "doc-1", 1, { title: "x" }, "user-1");
    await subject.listForDocuments("ws-a", ["doc-1"]);
    await subject.countForWorkspace("ws-a");
    await subject.delete("ws-a", "doc-1");
    await subject.upsert(upsertInput());

    expect(prisma.wheres.length).toBeGreaterThan(0);
    for (const where of prisma.wheres) {
      expect(where).toHaveProperty("workspaceId", "ws-a");
    }
  });
});

