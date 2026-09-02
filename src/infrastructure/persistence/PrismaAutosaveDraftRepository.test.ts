import { describe, expect, it } from "vitest";
import { PrismaAutosaveDraftRepository } from "./PrismaAutosaveDraftRepository";
import { InMemoryAutosaveDraftRepository } from "./InMemoryAutosaveDraftRepository";
import type { PrismaClient } from "@prisma/client";
import type { CreateAutosaveDraftInput } from "@/src/application/ports/workspaces/AutosaveDraftRepository";
import { AUTOSAVE_DRAFT_LIMITS as L } from "@/src/domain/entities/AutosaveDraft";

/**
 * Row-backed stand-in for the `autosaveDraft` delegate. The point is to drive
 * the adapter's real WHERE predicates, clamping and status handling — the parts
 * that decide whether one tenant can reach another's draft — without a database.
 * The fake resolves `where` generically, so a predicate the adapter forgets to
 * send is a predicate that simply does not filter, and the test fails.
 */
interface Row {
  id: string;
  workspaceId: string;
  organizationId: string;
  documentId: string;
  userId: string;
  deviceId: string;
  baseVersion: number;
  expectedRevision: number;
  snapshotKey: string;
  snapshotGeneration: number;
  checksum: string;
  byteSize: number;
  status: string;
  failureReason: string | null;
  leaseOwnerDeviceId: string | null;
  leaseExpiresAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key as keyof Row] === value);
}

type UpdateData = Record<string, unknown> & { version?: { increment: number } };

function fakePrisma(rows: Row[]) {
  let seq = 0;
  return {
    rows,
    autosaveDraft: {
      async findFirst({ where }: { where: Record<string, unknown>; select?: unknown }) {
        return rows.find((r) => matches(r, where)) ?? null;
      },
      async findMany({
        where,
        orderBy,
        take,
      }: {
        where: Record<string, unknown>;
        orderBy?: { updatedAt: "asc" | "desc" };
        take?: number;
      }) {
        const found = rows.filter((r) => matches(r, where));
        if (orderBy?.updatedAt === "desc") {
          found.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        }
        return take === undefined ? found : found.slice(0, take);
      },
      async create({ data }: { data: Partial<Row> }) {
        seq += 1;
        const now = new Date();
        const created: Row = {
          id: `draft-${seq}`,
          workspaceId: data.workspaceId!,
          organizationId: data.organizationId!,
          documentId: data.documentId!,
          userId: data.userId!,
          deviceId: data.deviceId!,
          baseVersion: data.baseVersion ?? 0,
          expectedRevision: data.expectedRevision ?? 0,
          snapshotKey: data.snapshotKey ?? "",
          snapshotGeneration: data.snapshotGeneration ?? 1,
          checksum: data.checksum ?? "",
          byteSize: data.byteSize ?? 0,
          status: data.status ?? "dirty",
          failureReason: data.failureReason ?? null,
          leaseOwnerDeviceId: data.leaseOwnerDeviceId ?? null,
          leaseExpiresAt: data.leaseExpiresAt ?? null,
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        rows.push(created);
        return created;
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: UpdateData }) {
        const targets = rows.filter((r) => matches(r, where));
        for (const target of targets) {
          for (const [key, value] of Object.entries(data)) {
            if (key === "version") continue;
            (target as unknown as Record<string, unknown>)[key] = value;
          }
          target.version += data.version?.increment ?? 0;
          target.updatedAt = new Date(target.updatedAt.getTime() + 1);
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
    },
  };
}

function repo(rows: Row[] = []) {
  const prisma = fakePrisma(rows);
  return {
    prisma,
    subject: new PrismaAutosaveDraftRepository(prisma as unknown as PrismaClient),
  };
}

function row(overrides: Partial<Row> = {}): Row {
  const now = new Date("2026-08-02T10:00:00.000Z");
  return {
    id: "draft-seed",
    workspaceId: "ws-a",
    organizationId: "org-a",
    documentId: "doc-1",
    userId: "user-1",
    deviceId: "device-a",
    baseVersion: 1,
    expectedRevision: 1,
    snapshotKey: "workspaces/ws-a/autosave/doc-1/user-1/hash/1.json",
    snapshotGeneration: 1,
    checksum: "a".repeat(64),
    byteSize: 12,
    status: "dirty",
    failureReason: null,
    leaseOwnerDeviceId: "device-a",
    leaseExpiresAt: new Date("2026-08-02T10:00:30.000Z"),
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createInput(overrides: Partial<CreateAutosaveDraftInput> = {}): CreateAutosaveDraftInput {
  return {
    workspaceId: "ws-a",
    organizationId: "org-a",
    documentId: "doc-1",
    userId: "user-1",
    deviceId: "device-a",
    baseVersion: 1,
    expectedRevision: 1,
    snapshotKey: "workspaces/ws-a/autosave/doc-1/user-1/hash/1.json",
    snapshotGeneration: 1,
    checksum: "b".repeat(64),
    byteSize: 12,
    status: "dirty",
    ...overrides,
  };
}

describe("PrismaAutosaveDraftRepository — tenant scoping", () => {
  it("never returns a draft from another Workspace", async () => {
    const { subject } = repo([row({ id: "d1", workspaceId: "ws-a" })]);

    expect(await subject.getById("ws-a", "d1")).not.toBeNull();
    expect(await subject.getById("ws-b", "d1")).toBeNull();
  });

  it("never returns another user's draft, even with the right device id", async () => {
    const { subject } = repo([row({ id: "d1", userId: "user-1", deviceId: "device-a" })]);

    expect(await subject.findByDevice("ws-a", "doc-1", "user-1", "device-a")).not.toBeNull();
    expect(await subject.findByDevice("ws-a", "doc-1", "user-2", "device-a")).toBeNull();
  });

  it("resolves a draft only on the full (workspace, document, user, device) identity", async () => {
    const { subject } = repo([row({ id: "d1" })]);

    expect(await subject.findByDevice("ws-b", "doc-1", "user-1", "device-a")).toBeNull();
    expect(await subject.findByDevice("ws-a", "doc-2", "user-1", "device-a")).toBeNull();
    expect(await subject.findByDevice("ws-a", "doc-1", "user-2", "device-a")).toBeNull();
    expect(await subject.findByDevice("ws-a", "doc-1", "user-1", "device-b")).toBeNull();
    expect(await subject.findByDevice("ws-a", "doc-1", "user-1", "device-a")).not.toBeNull();
  });

  it("lists only the addressed Workspace's and user's drafts", async () => {
    const { subject } = repo([
      row({ id: "d1", userId: "user-1" }),
      row({ id: "d2", userId: "user-2", deviceId: "device-b" }),
      row({ id: "d3", workspaceId: "ws-b", userId: "user-1", deviceId: "device-c" }),
    ]);

    expect((await subject.listByDocument("ws-a", "doc-1")).map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(
      (await subject.listByDocumentAndUser("ws-a", "doc-1", "user-1")).map((d) => d.id),
    ).toEqual(["d1"]);
  });

  it("deletes only within the addressed Workspace", async () => {
    const { subject, prisma } = repo([row({ id: "d1", workspaceId: "ws-a" })]);

    expect(await subject.delete("ws-b", "d1")).toBe(false);
    expect(prisma.rows).toHaveLength(1);
    expect(await subject.delete("ws-a", "d1")).toBe(true);
    expect(prisma.rows).toHaveLength(0);
    expect(await subject.delete("ws-a", "d1")).toBe(false);
  });

  it("scopes the snapshot-reference check to the Workspace", async () => {
    const key = "workspaces/ws-a/autosave/doc-1/user-1/hash/1.json";
    const { subject } = repo([row({ id: "d1", workspaceId: "ws-a", snapshotKey: key })]);

    expect(await subject.isSnapshotReferenced("ws-a", key)).toBe(true);
    expect(await subject.isSnapshotReferenced("ws-b", key)).toBe(false);
    expect(await subject.isSnapshotReferenced("ws-a", "some/other/key.json")).toBe(false);
  });
});

describe("PrismaAutosaveDraftRepository — optimistic concurrency", () => {
  it("rejects a stale version and leaves the row untouched", async () => {
    const { subject, prisma } = repo([row({ id: "d1", version: 5, status: "dirty" })]);

    const rejected = await subject.update("ws-a", "d1", { status: "saved" }, 4);

    expect(rejected).toBeNull();
    expect(prisma.rows[0].version).toBe(5);
    expect(prisma.rows[0].status).toBe("dirty");
  });

  it("increments the version exactly once on a matching write", async () => {
    const { subject } = repo([row({ id: "d1", version: 5 })]);

    const updated = await subject.update("ws-a", "d1", { status: "saved" }, 5);

    expect(updated!.version).toBe(6);
    expect(updated!.status).toBe("saved");
  });

  it("refuses a cross-Workspace write even without a version check", async () => {
    const { subject, prisma } = repo([row({ id: "d1", workspaceId: "ws-a", version: 2 })]);

    expect(await subject.update("ws-b", "d1", { status: "saved" })).toBeNull();
    expect(prisma.rows[0].version).toBe(2);
    expect(prisma.rows[0].status).toBe("dirty");
  });

  it("advances updatedAt but preserves createdAt", async () => {
    const created = new Date("2026-08-01T00:00:00.000Z");
    const { subject } = repo([row({ id: "d1", createdAt: created, updatedAt: created })]);

    const updated = await subject.update("ws-a", "d1", { status: "saved" });

    expect(updated!.createdAt.getTime()).toBe(created.getTime());
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(created.getTime());
  });

  it("repoints the snapshot and its integrity fields together", async () => {
    const { subject } = repo([row({ id: "d1" })]);

    const updated = await subject.update("ws-a", "d1", {
      snapshotKey: "workspaces/ws-a/autosave/doc-1/user-1/hash/2.json",
      snapshotGeneration: 2,
      checksum: "c".repeat(64),
      byteSize: 99,
    });

    expect(updated!.snapshotKey).toMatch(/2\.json$/);
    expect(updated!.snapshotGeneration).toBe(2);
    expect(updated!.checksum).toBe("c".repeat(64));
    expect(updated!.byteSize).toBe(99);
  });

  it("clears the lease when handed an explicit null", async () => {
    const { subject } = repo([row({ id: "d1" })]);

    const updated = await subject.update("ws-a", "d1", {
      leaseOwnerDeviceId: null,
      leaseExpiresAt: null,
      failureReason: null,
    });

    expect(updated!.leaseOwnerDeviceId).toBeNull();
    expect(updated!.leaseExpiresAt).toBeNull();
    expect(updated!.failureReason).toBeNull();
  });

  it("leaves untouched fields alone on a partial update", async () => {
    const { subject } = repo([row({ id: "d1", checksum: "d".repeat(64), byteSize: 42 })]);

    const updated = await subject.update("ws-a", "d1", { status: "conflict" });

    expect(updated!.checksum).toBe("d".repeat(64));
    expect(updated!.byteSize).toBe(42);
    expect(updated!.leaseOwnerDeviceId).toBe("device-a");
  });
});

describe("PrismaAutosaveDraftRepository — bounded reads", () => {
  it("treats an unrecognized stored status as a conflict, never as clean", async () => {
    for (const bad of ["", "committed", "DIRTY", "deleted"]) {
      const { subject } = repo([row({ id: "d1", status: bad })]);
      expect((await subject.getById("ws-a", "d1"))!.status).toBe("conflict");
    }
  });

  it("passes through every legitimate status unchanged", async () => {
    for (const status of ["dirty", "saved", "conflict", "stale"] as const) {
      const { subject } = repo([row({ id: "d1", status })]);
      expect((await subject.getById("ws-a", "d1"))!.status).toBe(status);
    }
  });

  it("bounds oversized stored strings on read", async () => {
    const { subject } = repo([
      row({
        id: "d1",
        deviceId: "x".repeat(L.maxDeviceIdLength + 50),
        snapshotKey: "k".repeat(L.maxSnapshotKeyLength + 50),
        failureReason: "r".repeat(L.maxFailureReasonLength + 50),
        leaseOwnerDeviceId: "y".repeat(L.maxDeviceIdLength + 50),
      }),
    ]);

    const draft = (await subject.getById("ws-a", "d1"))!;
    expect(draft.deviceId).toHaveLength(L.maxDeviceIdLength);
    expect(draft.snapshotKey).toHaveLength(L.maxSnapshotKeyLength);
    expect(draft.failureReason).toHaveLength(L.maxFailureReasonLength);
    expect(draft.leaseOwnerDeviceId).toHaveLength(L.maxDeviceIdLength);
  });

  it("bounds nonsensical stored counters instead of surfacing them", async () => {
    const { subject } = repo([
      row({
        id: "d1",
        baseVersion: -5,
        expectedRevision: Number.NaN,
        byteSize: L.maxCounter * 10,
        snapshotGeneration: 2.9,
      }),
    ]);

    const draft = (await subject.getById("ws-a", "d1"))!;
    expect(draft.baseVersion).toBe(0);
    expect(draft.expectedRevision).toBe(0);
    expect(draft.byteSize).toBe(L.maxCounter);
    expect(draft.snapshotGeneration).toBe(2);
  });

  it("truncates oversized values on write rather than storing them", async () => {
    const { subject, prisma } = repo();

    await subject.create(
      createInput({
        deviceId: "x".repeat(L.maxDeviceIdLength + 50),
        snapshotKey: "k".repeat(L.maxSnapshotKeyLength + 50),
        leaseOwnerDeviceId: "y".repeat(L.maxDeviceIdLength + 50),
      }),
    );

    expect(prisma.rows[0].deviceId).toHaveLength(L.maxDeviceIdLength);
    expect(prisma.rows[0].snapshotKey).toHaveLength(L.maxSnapshotKeyLength);
    expect(prisma.rows[0].leaseOwnerDeviceId).toHaveLength(L.maxDeviceIdLength);
  });

  it("truncates an oversized failure reason on update", async () => {
    const { subject, prisma } = repo([row({ id: "d1" })]);

    await subject.update("ws-a", "d1", { failureReason: "r".repeat(L.maxFailureReasonLength + 50) });

    expect(prisma.rows[0].failureReason).toHaveLength(L.maxFailureReasonLength);
  });

  it("caps a listing at the domain maximum however large a limit is asked for", async () => {
    const many = Array.from({ length: L.maxDraftsPerDocument + 10 }, (_, i) =>
      row({ id: `d${i}`, deviceId: `device-${i}` }),
    );
    const { subject } = repo(many);

    expect(await subject.listByDocument("ws-a", "doc-1", 9_999)).toHaveLength(
      L.maxDraftsPerDocument,
    );
    expect(await subject.listByDocument("ws-a", "doc-1")).toHaveLength(L.maxDraftsPerDocument);
    expect(
      await subject.listByDocumentAndUser("ws-a", "doc-1", "user-1", Number.POSITIVE_INFINITY),
    ).toHaveLength(L.maxDraftsPerDocument);
  });

  it("returns at least one row for a nonsensical limit rather than everything", async () => {
    const { subject } = repo([row({ id: "d1" }), row({ id: "d2", deviceId: "device-b" })]);

    expect(await subject.listByDocument("ws-a", "doc-1", 0)).toHaveLength(1);
    expect(await subject.listByDocument("ws-a", "doc-1", -3)).toHaveLength(1);
    expect(await subject.listByDocument("ws-a", "doc-1", Number.NaN)).toHaveLength(1);
  });

  it("orders a listing newest first", async () => {
    const { subject } = repo([
      row({ id: "old", deviceId: "device-a", updatedAt: new Date("2026-08-01T00:00:00.000Z") }),
      row({ id: "new", deviceId: "device-b", updatedAt: new Date("2026-08-03T00:00:00.000Z") }),
    ]);

    expect((await subject.listByDocument("ws-a", "doc-1")).map((d) => d.id)).toEqual([
      "new",
      "old",
    ]);
  });
});

describe("PrismaAutosaveDraftRepository — mutation isolation", () => {
  it("a returned draft cannot be mutated into persisted state", async () => {
    const { subject } = repo([row({ id: "d1" })]);

    const first = (await subject.getById("ws-a", "d1"))!;
    first.status = "saved";
    first.snapshotKey = "attacker/key.json";
    first.byteSize = 999_999;

    const second = (await subject.getById("ws-a", "d1"))!;
    expect(second.status).toBe("dirty");
    expect(second.snapshotKey).not.toBe("attacker/key.json");
    expect(second.byteSize).toBe(12);
  });

  it("a returned lease date cannot be mutated into persisted state", async () => {
    const { subject } = repo([row({ id: "d1" })]);

    const draft = (await subject.getById("ws-a", "d1"))!;
    const original = draft.leaseExpiresAt!.getTime();
    draft.leaseExpiresAt!.setFullYear(2099);

    expect((await subject.getById("ws-a", "d1"))!.leaseExpiresAt!.getTime()).toBe(original);
  });
});

/**
 * Both adapters back the same port, so AutosaveService must behave identically
 * against either. These pin the observable contract they share.
 */
describe("AutosaveDraftRepository — adapter parity", () => {
  it("agrees on identity, scoping and version behaviour", async () => {
    const prismaBacked = repo().subject;
    const memoryBacked = new InMemoryAutosaveDraftRepository();

    for (const subject of [prismaBacked, memoryBacked]) {
      const created = await subject.create(createInput());
      expect(created.version).toBe(1);
      expect(created.status).toBe("dirty");
      expect(created.snapshotGeneration).toBe(1);
      expect(created.failureReason).toBeNull();

      // Reachable on its full identity, unreachable on any partial one.
      expect(await subject.findByDevice("ws-a", "doc-1", "user-1", "device-a")).not.toBeNull();
      expect(await subject.findByDevice("ws-a", "doc-1", "user-2", "device-a")).toBeNull();
      expect(await subject.getById("ws-b", created.id)).toBeNull();

      // Cross-Workspace and stale writes are refused; a matching one is accepted.
      expect(await subject.update("ws-b", created.id, { status: "saved" })).toBeNull();
      expect(await subject.update("ws-a", created.id, { status: "saved" }, 99)).toBeNull();
      const bumped = await subject.update("ws-a", created.id, { status: "saved" }, 1);
      expect(bumped!.version).toBe(2);
      expect(bumped!.status).toBe("saved");
      expect(bumped!.createdAt.getTime()).toBe(created.createdAt.getTime());

      // The snapshot guard sees the row's current key.
      expect(await subject.isSnapshotReferenced("ws-a", created.snapshotKey)).toBe(true);
      expect(await subject.isSnapshotReferenced("ws-b", created.snapshotKey)).toBe(false);

      expect(await subject.delete("ws-b", created.id)).toBe(false);
      expect(await subject.delete("ws-a", created.id)).toBe(true);
      expect(await subject.getById("ws-a", created.id)).toBeNull();
      expect(await subject.isSnapshotReferenced("ws-a", created.snapshotKey)).toBe(false);
    }
  });

  it("agrees that separate devices and users hold separate drafts", async () => {
    const prismaBacked = repo().subject;
    const memoryBacked = new InMemoryAutosaveDraftRepository();

    for (const subject of [prismaBacked, memoryBacked]) {
      const mine = await subject.create(createInput({ deviceId: "device-a" }));
      const myOther = await subject.create(createInput({ deviceId: "device-b" }));
      const theirs = await subject.create(createInput({ userId: "user-2", deviceId: "device-a" }));

      expect(new Set([mine.id, myOther.id, theirs.id]).size).toBe(3);
      expect((await subject.listByDocument("ws-a", "doc-1")).length).toBe(3);
      const own = await subject.listByDocumentAndUser("ws-a", "doc-1", "user-1");
      expect(own.map((d) => d.deviceId).sort()).toEqual(["device-a", "device-b"]);
    }
  });

  it("agrees on the listing bound, whatever limit is asked for", async () => {
    const prismaBacked = repo().subject;
    const memoryBacked = new InMemoryAutosaveDraftRepository();

    for (const subject of [prismaBacked, memoryBacked]) {
      for (let i = 0; i < L.maxDraftsPerDocument + 5; i += 1) {
        await subject.create(createInput({ deviceId: `device-${i}` }));
      }

      expect(await subject.listByDocument("ws-a", "doc-1")).toHaveLength(L.maxDraftsPerDocument);
      expect(await subject.listByDocument("ws-a", "doc-1", 9_999)).toHaveLength(
        L.maxDraftsPerDocument,
      );
      expect(await subject.listByDocument("ws-a", "doc-1", Number.POSITIVE_INFINITY)).toHaveLength(
        L.maxDraftsPerDocument,
      );
      expect(await subject.listByDocument("ws-a", "doc-1", 3)).toHaveLength(3);
      // A nonsensical limit narrows to one row; it never widens the read.
      expect(await subject.listByDocument("ws-a", "doc-1", 0)).toHaveLength(1);
      expect(await subject.listByDocument("ws-a", "doc-1", Number.NaN)).toHaveLength(1);
    }
  });
});
