import { describe, expect, it } from "vitest";
import { PrismaTagRepository } from "./PrismaTagRepository";
import type { PrismaClient } from "@prisma/client";
import { TAG_LIMITS as L } from "@/src/domain/entities/Tag";

/**
 * Row-backed stand-in for the `tag` delegate.
 *
 * The fake resolves `where` generically and enforces the real
 * (workspaceId, normalizedName) unique constraint, so the adapter's predicates
 * are what the assertions exercise: a Workspace predicate the adapter forgets to
 * send simply does not filter, and the test fails.
 */
interface Row {
  id: string;
  organizationId: string;
  workspaceId: string;
  name: string;
  normalizedName: string;
  color: string | null;
  createdById: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

type Operators = { gt?: string; in?: string[] };

function matchValue(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !(expected instanceof Date)) {
    const ops = expected as Operators;
    if ("gt" in ops) return typeof actual === "string" && actual > (ops.gt as string);
    if ("in" in ops) return Array.isArray(ops.in) && ops.in.includes(actual as string);
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
      if (rows.some((r) => r.workspaceId === data.workspaceId && r.normalizedName === data.normalizedName)) {
        throw uniqueViolation();
      }
      seq += 1;
      const created: Row = {
        id: `tag-${seq}`,
        organizationId: data.organizationId!,
        workspaceId: data.workspaceId!,
        name: data.name!,
        normalizedName: data.normalizedName!,
        color: data.color ?? null,
        createdById: data.createdById!,
        revision: data.revision ?? 1,
        createdAt: data.createdAt ?? new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: data.updatedAt ?? new Date("2026-08-01T00:00:00.000Z"),
      };
      rows.push(created);
      return created;
    },
    async updateMany({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Partial<Row> & { revision?: unknown };
    }) {
      const targets = rows.filter((r) => matches(r, where));
      // The unique index applies to updates as well as inserts: a rename onto a
      // name already taken in the Workspace is the collision the adapter must
      // surface rather than silently absorb.
      for (const target of targets) {
        if (
          typeof data.normalizedName === "string" &&
          rows.some(
            (r) =>
              r.id !== target.id &&
              r.workspaceId === target.workspaceId &&
              r.normalizedName === data.normalizedName,
          )
        ) {
          throw uniqueViolation();
        }
      }
      for (const target of targets) {
        const { revision: _revision, ...rest } = data;
        Object.assign(target, rest, { revision: target.revision + 1 });
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

  return { rows, tag: delegate };
}

function repo(rows: Row[] = []) {
  const prisma = fakePrisma(rows);
  return {
    prisma,
    subject: new PrismaTagRepository(prisma as unknown as PrismaClient),
  };
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "tag-seed",
    organizationId: "org-a",
    workspaceId: "ws-a",
    name: "Contract",
    normalizedName: "contract",
    color: "#3366cc",
    createdById: "user-1",
    revision: 1,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createInput(overrides: Partial<Parameters<ReturnType<typeof repo>["subject"]["create"]>[0]> = {}) {
  return {
    organizationId: "org-a",
    workspaceId: "ws-a",
    name: "Contract",
    normalizedName: "contract",
    color: "#3366cc" as string | null,
    createdById: "user-1",
    ...overrides,
  };
}

describe("PrismaTagRepository", () => {
  it("creates a tag and returns a domain row with copied dates", async () => {
    const { subject, prisma } = repo();
    const created = await subject.create(createInput());

    expect(created.id).toMatch(/^tag-/);
    expect(created.workspaceId).toBe("ws-a");
    expect(created.revision).toBe(1);
    expect(prisma.rows).toHaveLength(1);

    // The caller must not be able to mutate the stored row's timestamps.
    created.createdAt.setFullYear(1990);
    expect(prisma.rows[0].createdAt.getFullYear()).not.toBe(1990);
  });

  it("rejects a duplicate normalized name in the same Workspace with a unique violation", async () => {
    const { subject, prisma } = repo([row()]);
    await expect(subject.create(createInput())).rejects.toMatchObject({ code: "P2002" });
    expect(prisma.rows).toHaveLength(1);
  });

  it("allows the same normalized name in a different Workspace", async () => {
    const { subject } = repo([row()]);
    const created = await subject.create(createInput({ workspaceId: "ws-b" }));
    expect(created.workspaceId).toBe("ws-b");
  });

  it("reads by id and Workspace, so a foreign id reads as missing", async () => {
    const { subject } = repo([row()]);
    expect(await subject.getById("ws-a", "tag-seed")).not.toBeNull();
    expect(await subject.getById("ws-b", "tag-seed")).toBeNull();
    expect(await subject.getById("ws-a", "tag-unknown")).toBeNull();
  });

  it("reads by normalized name within a Workspace", async () => {
    const { subject } = repo([row()]);
    expect(await subject.getByNormalizedName("ws-a", "contract")).not.toBeNull();
    expect(await subject.getByNormalizedName("ws-b", "contract")).toBeNull();
  });

  it("lists only the Workspace's tags, ordered and bounded by the shared cap", async () => {
    const { subject } = repo([
      row({ id: "t1", workspaceId: "ws-a", normalizedName: "a" }),
      row({ id: "t2", workspaceId: "ws-a", normalizedName: "b" }),
      row({ id: "t3", workspaceId: "ws-a", normalizedName: "c" }),
      row({ id: "t4", workspaceId: "ws-b", normalizedName: "z" }),
    ]);

    const listed = await subject.list({ workspaceId: "ws-a", limit: 2 });
    expect(listed.map((t) => t.normalizedName)).toEqual(["a", "b"]);

    const after = await subject.list({ workspaceId: "ws-a", limit: 2, afterNormalizedName: "b" });
    expect(after.map((t) => t.normalizedName)).toEqual(["c"]);
  });

  it("resolves a batch of ids within the Workspace", async () => {
    const { subject } = repo([
      row({ id: "t1", workspaceId: "ws-a" }),
      row({ id: "t2", workspaceId: "ws-a" }),
      row({ id: "t3", workspaceId: "ws-b" }),
    ]);

    const many = await subject.getManyByIds("ws-a", ["t1", "t2", "t3"]);
    expect(many.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
  });

  it("updates compare-and-swap on revision and increments it", async () => {
    const { subject } = repo([row()]);

    const updated = await subject.update("ws-a", "tag-seed", 1, { name: "Draft", normalizedName: "draft" });
    expect(updated?.name).toBe("Draft");
    expect(updated?.revision).toBe(2);

    const persisted = await subject.getById("ws-a", "tag-seed");
    expect(persisted?.revision).toBe(2);
  });

  it("returns null for a stale revision, indistinguishable from a missing tag", async () => {
    const { subject } = repo([row()]);
    expect(await subject.update("ws-a", "tag-seed", 99, { name: "Draft" })).toBeNull();
    expect(await subject.update("ws-b", "tag-seed", 1, { name: "Draft" })).toBeNull();
  });

  it("surfaces the unique violation on a rename that collides", async () => {
    const { subject } = repo([
      row({ id: "t1", workspaceId: "ws-a", normalizedName: "contract" }),
      row({ id: "t2", workspaceId: "ws-a", normalizedName: "draft" }),
    ]);

    await expect(
      subject.update("ws-a", "t2", 1, { name: "Contract", normalizedName: "contract" }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("deletes scoped to the Workspace", async () => {
    const { subject, prisma } = repo([
      row({ id: "t1", workspaceId: "ws-a" }),
      row({ id: "t2", workspaceId: "ws-b" }),
    ]);

    expect(await subject.delete("ws-a", "t1")).toBe(true);
    expect(await subject.delete("ws-a", "t2")).toBe(false);
    expect(prisma.rows.map((r) => r.id)).toEqual(["t2"]);
  });

  it("counts within the Workspace", async () => {
    const { subject } = repo([row({ workspaceId: "ws-a" }), row({ id: "t2", workspaceId: "ws-b" })]);
    expect(await subject.countForWorkspace("ws-a")).toBe(1);
  });

  it("clamps an oversized colour to the domain bound rather than storing it", async () => {
    const { subject } = repo();
    const created = await subject.create(
      createInput({ color: "#" + "a".repeat(L.maxColorLength + 1) }),
    );
    expect(created.color).toHaveLength(L.maxColorLength);
  });

  it("clamps an oversized name to the domain bound", async () => {
    const { subject } = repo();
    const created = await subject.create(
      createInput({
        name: "n".repeat(L.maxNameLength + 50),
        normalizedName: "n".repeat(L.maxNameLength + 50),
      }),
    );
    expect(created.name).toHaveLength(L.maxNameLength);
    expect(created.normalizedName).toHaveLength(L.maxNameLength);
  });

  it("degrades an unusable stored revision to 1 rather than leaking it", async () => {
    const { subject } = repo([row({ revision: Number.NaN as unknown as number })]);
    const read = await subject.getById("ws-a", "tag-seed");
    expect(read?.revision).toBe(1);
  });
});
