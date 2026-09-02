import { describe, expect, it } from "vitest";
import { PrismaSmartCollectionRepository } from "./PrismaSmartCollectionRepository";
import type { PrismaClient } from "@prisma/client";
import { SMART_COLLECTION_LIMITS as L } from "@/src/domain/entities/SmartCollection";

/**
 * Row-backed stand-in for the `smartCollection` delegate, enforcing the real
 * (workspaceId, normalizedName) unique constraint so the adapter's own
 * predicates and its bounded deserialization are what the assertions exercise.
 */
interface Row {
  id: string;
  organizationId: string;
  workspaceId: string;
  name: string;
  normalizedName: string;
  queryVersion: number;
  query: string;
  createdById: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

function matchValue(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !(expected instanceof Date)) {
    const ops = expected as { gt?: string };
    if ("gt" in ops) return typeof actual === "string" && actual > (ops.gt as string);
    return false;
  }
  return actual === expected;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => matchValue(row[key as keyof Row], value));
}

function uniqueViolation(): Error {
  const error = new Error("Unique constraint failed on the fields: (`workspaceId`,`normalizedName`)");
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
      orderBy?: { normalizedName: "asc" };
      take?: number;
    }) {
      const found = rows.filter((r) => matches(r, where));
      // Ordering is applied only when the adapter asked for it, so a listing that
      // forgets `orderBy` comes back unordered and the assertion catches it.
      if (orderBy?.normalizedName === "asc") {
        found.sort((a, b) => a.normalizedName.localeCompare(b.normalizedName));
      }
      return take === undefined ? found : found.slice(0, take);
    },
    async create({ data }: { data: Partial<Row> }) {
      if (
        rows.some(
          (r) => r.workspaceId === data.workspaceId && r.normalizedName === data.normalizedName,
        )
      ) {
        throw uniqueViolation();
      }
      seq += 1;
      const created: Row = {
        id: `collection-${seq}`,
        organizationId: data.organizationId!,
        workspaceId: data.workspaceId!,
        name: data.name!,
        normalizedName: data.normalizedName!,
        queryVersion: data.queryVersion ?? L.queryVersion,
        query: data.query!,
        createdById: data.createdById!,
        revision: data.revision ?? 1,
        createdAt: data.createdAt ?? new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: data.updatedAt ?? new Date("2026-08-01T00:00:00.000Z"),
      };
      rows.push(created);
      return created;
    },
    async updateMany({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) {
      const targets = rows.filter((r) => matches(r, where));
      for (const target of targets) {
        Object.assign(target, data, {
          revision: target.revision + 1,
          updatedAt: new Date("2026-08-02T00:00:00.000Z"),
        });
      }
      return { count: targets.length };
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

  return { rows, smartCollection: delegate };
}

function repo(rows: Row[] = []) {
  const prisma = fakePrisma(rows);
  return {
    prisma,
    subject: new PrismaSmartCollectionRepository(prisma as unknown as PrismaClient),
  };
}

function queryJson(term = "contract"): string {
  return JSON.stringify({
    version: 1,
    root: { mode: "all", conditions: [{ field: "name", operator: "contains", value: term }] },
  });
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "collection-seed",
    organizationId: "org-a",
    workspaceId: "ws-a",
    name: "Contracts",
    normalizedName: "contracts",
    queryVersion: 1,
    query: queryJson(),
    createdById: "user-1",
    revision: 1,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createInput(
  overrides: Partial<Parameters<ReturnType<typeof repo>["subject"]["create"]>[0]> = {},
) {
  return {
    organizationId: "org-a",
    workspaceId: "ws-a",
    name: "Contracts",
    normalizedName: "contracts",
    queryVersion: 1,
    queryJson: queryJson(),
    createdById: "user-1",
    ...overrides,
  };
}

describe("PrismaSmartCollectionRepository", () => {
  it("creates a collection and deserializes its stored definition", async () => {
    const { subject } = repo();
    const created = await subject.create(createInput());

    expect(created.id).toMatch(/^collection-/);
    expect(created.queryDegraded).toBe(false);
    expect(created.query.root.conditions[0].value).toBe("contract");
    expect(created.revision).toBe(1);
  });

  it("rejects a duplicate normalized name in the same Workspace", async () => {
    const { subject } = repo([row()]);
    await expect(subject.create(createInput())).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows the same normalized name in another Workspace", async () => {
    const { subject } = repo([row()]);
    const created = await subject.create(createInput({ workspaceId: "ws-b" }));
    expect(created.workspaceId).toBe("ws-b");
  });

  it("reads by id scoped to the Workspace", async () => {
    const { subject } = repo([row()]);
    expect(await subject.getById("ws-a", "collection-seed")).not.toBeNull();
    expect(await subject.getById("ws-b", "collection-seed")).toBeNull();
  });

  it("reads by normalized name scoped to the Workspace", async () => {
    const { subject } = repo([row()]);
    expect(await subject.getByNormalizedName("ws-a", "contracts")).not.toBeNull();
    expect(await subject.getByNormalizedName("ws-b", "contracts")).toBeNull();
  });

  it("lists only the Workspace's collections, ordered and bounded", async () => {
    const { subject } = repo([
      row({ id: "c1", normalizedName: "alpha" }),
      row({ id: "c2", normalizedName: "beta" }),
      row({ id: "c3", normalizedName: "gamma" }),
      row({ id: "c4", normalizedName: "delta", workspaceId: "ws-b" }),
    ]);

    const first = await subject.list({ workspaceId: "ws-a", limit: 2 });
    expect(first.map((c) => c.normalizedName)).toEqual(["alpha", "beta"]);

    const after = await subject.list({
      workspaceId: "ws-a",
      limit: 5,
      afterNormalizedName: "beta",
    });
    expect(after.map((c) => c.normalizedName)).toEqual(["gamma"]);
  });

  it("degrades an unparseable stored definition to an empty query rather than to everything", async () => {
    const { subject } = repo([row({ query: "{ not json" })]);
    const read = await subject.getById("ws-a", "collection-seed");

    expect(read?.queryDegraded).toBe(true);
    expect(read?.query.root.conditions).toEqual([]);
  });

  it("degrades a stored definition carrying an unknown grammar version", async () => {
    const { subject } = repo([
      row({ query: JSON.stringify({ version: 99, root: { mode: "all", conditions: [] } }) }),
    ]);
    const read = await subject.getById("ws-a", "collection-seed");

    expect(read?.queryDegraded).toBe(true);
    expect(read?.query.root.conditions).toEqual([]);
  });

  it("degrades a stored definition that exceeds the size bound", async () => {
    const oversized = JSON.stringify({
      version: 1,
      root: {
        mode: "all",
        conditions: [{ field: "name", operator: "contains", value: "x".repeat(L.maxQueryBytes) }],
      },
    });
    const { subject } = repo([row({ query: oversized })]);
    const read = await subject.getById("ws-a", "collection-seed");

    expect(read?.queryDegraded).toBe(true);
  });

  it("updates compare-and-swap on revision, preserving createdAt and advancing updatedAt", async () => {
    const { subject } = repo([row()]);
    const before = await subject.getById("ws-a", "collection-seed");

    const updated = await subject.update("ws-a", "collection-seed", 1, {
      name: "Signed",
      normalizedName: "signed",
    });

    expect(updated?.name).toBe("Signed");
    expect(updated?.revision).toBe(2);
    expect(updated?.createdAt.getTime()).toBe(before!.createdAt.getTime());
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });

  it("returns null for a stale revision or a foreign Workspace, without distinguishing them", async () => {
    const { subject } = repo([row()]);
    expect(await subject.update("ws-a", "collection-seed", 99, { name: "X" })).toBeNull();
    expect(await subject.update("ws-b", "collection-seed", 1, { name: "X" })).toBeNull();
  });

  it("stores a replaced query definition and reads it back parsed", async () => {
    const { subject } = repo([row()]);
    const updated = await subject.update("ws-a", "collection-seed", 1, {
      queryVersion: 1,
      queryJson: queryJson("invoice"),
    });

    expect(updated?.query.root.conditions[0].value).toBe("invoice");
    expect(updated?.queryDegraded).toBe(false);
  });

  it("deletes scoped to the Workspace", async () => {
    const { subject, prisma } = repo([
      row({ id: "c1", workspaceId: "ws-a" }),
      row({ id: "c2", workspaceId: "ws-b" }),
    ]);

    expect(await subject.delete("ws-a", "c1")).toBe(true);
    expect(await subject.delete("ws-a", "c2")).toBe(false);
    expect(prisma.rows.map((r) => r.id)).toEqual(["c2"]);
  });

  it("counts within the Workspace", async () => {
    const { subject } = repo([
      row({ id: "c1", normalizedName: "a" }),
      row({ id: "c2", normalizedName: "b" }),
      row({ id: "c3", normalizedName: "c", workspaceId: "ws-b" }),
    ]);

    expect(await subject.countForWorkspace("ws-a")).toBe(2);
  });
});
