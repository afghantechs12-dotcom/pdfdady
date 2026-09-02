import { describe, expect, it } from "vitest";
import { PrismaWorkspaceSessionRepository } from "./PrismaWorkspaceSessionRepository";
import { InMemoryWorkspaceSessionRepository } from "./InMemoryWorkspaceSessionRepository";
import type { PrismaClient } from "@prisma/client";
import type { WorkspaceSessionTab } from "@/src/domain/entities/WorkspaceSession";
import { WORKSPACE_SESSION_LIMITS as L } from "@/src/domain/entities/WorkspaceSession";

/**
 * Minimal stand-in for the `workspaceSession` delegate, backed by a plain array
 * of rows. It lets these tests drive the adapter's real deserialization and
 * scoping logic — the parts that are easy to get wrong — without a database.
 */
interface Row {
  id: string;
  userId: string;
  workspaceId: string;
  organizationId: string;
  activeTabId: string | null;
  tabs: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key as keyof Row] === value);
}

function fakePrisma(rows: Row[]) {
  let seq = 0;
  return {
    rows,
    workspaceSession: {
      async findFirst({ where }: { where: Record<string, unknown> }) {
        return rows.find((r) => matches(r, where)) ?? null;
      },
      async create({ data }: { data: Partial<Row> }) {
        seq += 1;
        const now = new Date();
        const row: Row = {
          id: `row-${seq}`,
          userId: data.userId!,
          workspaceId: data.workspaceId!,
          organizationId: data.organizationId!,
          activeTabId: data.activeTabId ?? null,
          tabs: data.tabs ?? "[]",
          version: 1,
          createdAt: now,
          updatedAt: now,
        };
        rows.push(row);
        return row;
      },
      async updateMany({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: { activeTabId: string | null; tabs: string; version: { increment: number } };
      }) {
        const targets = rows.filter((r) => matches(r, where));
        for (const row of targets) {
          row.activeTabId = data.activeTabId;
          row.tabs = data.tabs;
          row.version += data.version.increment;
          row.updatedAt = new Date(row.updatedAt.getTime() + 1);
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
    subject: new PrismaWorkspaceSessionRepository(prisma as unknown as PrismaClient),
  };
}

function row(overrides: Partial<Row> = {}): Row {
  const now = new Date("2026-08-02T10:00:00.000Z");
  return {
    id: "row-seed",
    userId: "user-1",
    workspaceId: "ws-a",
    organizationId: "org-a",
    activeTabId: null,
    tabs: "[]",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function tab(overrides: Partial<WorkspaceSessionTab> = {}): WorkspaceSessionTab {
  const now = new Date("2026-08-02T10:00:00.000Z");
  return {
    id: "tab-1",
    documentId: "doc-1",
    versionId: "doc-1-v1",
    title: "Report.pdf",
    state: { activePage: 3, tool: "select", dirty: false, lastAccessed: now },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("PrismaWorkspaceSessionRepository — scoping", () => {
  it("never returns another user's session", async () => {
    const { subject } = repo([row({ id: "s1", userId: "user-1" })]);

    expect(await subject.getByIdForUser("s1", "user-1")).not.toBeNull();
    expect(await subject.getByIdForUser("s1", "user-2")).toBeNull();
    expect(await subject.getForUser("ws-a", "user-2")).toBeNull();
  });

  it("never returns another workspace's session", async () => {
    const { subject } = repo([row({ id: "s1", workspaceId: "ws-a" })]);

    expect(await subject.getForUser("ws-a", "user-1")).not.toBeNull();
    expect(await subject.getForUser("ws-b", "user-1")).toBeNull();
  });

  it("is idempotent per (workspace, user) on create", async () => {
    const { subject, prisma } = repo();

    const first = await subject.create({
      workspaceId: "ws-a",
      organizationId: "org-a",
      userId: "user-1",
      activeTabId: null,
      tabs: [],
    });
    const second = await subject.create({
      workspaceId: "ws-a",
      organizationId: "org-a",
      userId: "user-1",
      activeTabId: null,
      tabs: [],
    });

    expect(second.id).toBe(first.id);
    expect(prisma.rows).toHaveLength(1);
  });

  it("deletes only the owner's session", async () => {
    const { subject } = repo([row({ id: "s1", userId: "user-1" })]);

    expect(await subject.delete("s1", "user-2")).toBe(false);
    expect(await subject.delete("s1", "user-1")).toBe(true);
    expect(await subject.delete("s1", "user-1")).toBe(false);
  });
});

describe("PrismaWorkspaceSessionRepository — optimistic concurrency", () => {
  it("rejects a stale version and leaves the row untouched", async () => {
    const { subject, prisma } = repo([row({ id: "s1", version: 5, tabs: JSON.stringify([tab()]) })]);

    const rejected = await subject.update("s1", "user-1", { activeTabId: null, tabs: [] }, 4);

    expect(rejected).toBeNull();
    expect(prisma.rows[0].version).toBe(5);
    expect(prisma.rows[0].tabs).toBe(JSON.stringify([tab()]));
  });

  it("increments the version exactly once on a matching write", async () => {
    const { subject } = repo([row({ id: "s1", version: 5 })]);

    const updated = await subject.update("s1", "user-1", { activeTabId: null, tabs: [] }, 5);

    expect(updated!.version).toBe(6);
  });

  it("advances updatedAt but preserves createdAt", async () => {
    const created = new Date("2026-08-01T00:00:00.000Z");
    const { subject } = repo([row({ id: "s1", createdAt: created })]);

    const updated = await subject.update("s1", "user-1", { activeTabId: null, tabs: [] });

    expect(updated!.createdAt.getTime()).toBe(created.getTime());
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(created.getTime());
  });

  it("refuses a write for a non-owner even without a version check", async () => {
    const { subject, prisma } = repo([row({ id: "s1", userId: "user-1", version: 2 })]);

    expect(await subject.update("s1", "user-2", { activeTabId: null, tabs: [] })).toBeNull();
    expect(prisma.rows[0].version).toBe(2);
  });
});

describe("PrismaWorkspaceSessionRepository — deserialization", () => {
  it("round-trips a stored tab", async () => {
    const { subject } = repo();
    const source = tab({ state: { activePage: 4, viewport: { scale: 1.25, offsetX: 10, offsetY: -5 }, selection: { start: 2, end: 9 }, dirty: true, conflict: true, lastAccessed: new Date("2026-08-02T11:00:00.000Z") } });

    const created = await subject.create({
      workspaceId: "ws-a",
      organizationId: "org-a",
      userId: "user-1",
      activeTabId: source.id,
      tabs: [source],
    });

    expect(created.tabs).toHaveLength(1);
    const restored = created.tabs[0];
    expect(restored.id).toBe(source.id);
    expect(restored.documentId).toBe(source.documentId);
    expect(restored.title).toBe(source.title);
    expect(restored.state.activePage).toBe(4);
    expect(restored.state.viewport).toEqual({ scale: 1.25, offsetX: 10, offsetY: -5 });
    expect(restored.state.selection).toEqual({ start: 2, end: 9 });
    expect(restored.state.dirty).toBe(true);
    expect(restored.state.conflict).toBe(true);
    expect(restored.state.lastAccessed).toBeInstanceOf(Date);
    expect(created.activeTabId).toBe(source.id);
  });

  it("treats malformed JSON as an empty tab set instead of throwing", async () => {
    for (const bad of ["not json at all", "{}", '"a string"', "null", "[1,2,3]"]) {
      const { subject } = repo([row({ id: "s1", tabs: bad })]);
      const session = await subject.getByIdForUser("s1", "user-1");
      expect(session).not.toBeNull();
      expect(session!.tabs).toEqual([]);
    }
  });

  it("drops tabs lacking a usable identity", async () => {
    const stored = JSON.stringify([
      tab({ id: "tab-ok" }),
      { ...tab(), id: "" },
      { ...tab(), documentId: undefined },
      { ...tab(), id: "x".repeat(L.maxIdLength + 1) },
      null,
      "a string",
    ]);
    const { subject } = repo([row({ id: "s1", tabs: stored })]);

    const session = await subject.getByIdForUser("s1", "user-1");
    expect(session!.tabs.map((t) => t.id)).toEqual(["tab-ok"]);
  });

  it("drops out-of-bounds view state rather than returning it", async () => {
    const stored = JSON.stringify([
      tab({
        id: "tab-1",
        state: {
          activePage: L.maxPage + 1,
          viewport: { scale: 9_999, offsetX: 0, offsetY: 0 },
          selection: { start: 90, end: 10 },
          tool: "t".repeat(L.maxToolLength + 1),
          lastAccessed: new Date(),
        },
      }),
    ]);
    const { subject } = repo([row({ id: "s1", tabs: stored })]);

    const state = (await subject.getByIdForUser("s1", "user-1"))!.tabs[0].state;
    expect(state.activePage).toBeUndefined();
    expect(state.viewport).toBeUndefined();
    expect(state.selection).toBeUndefined();
    expect(state.tool).toBeUndefined();
  });

  it("rejects embedded content urls found in a stored payload", async () => {
    const stored = JSON.stringify([
      tab({ id: "tab-1", title: "data:text/html,<script>alert(1)</script>" }),
      tab({ id: "tab-2", documentId: "blob:https://evil/x" }),
    ]);
    const { subject } = repo([row({ id: "s1", tabs: stored })]);

    const tabs = (await subject.getByIdForUser("s1", "user-1"))!.tabs;
    // tab-1 keeps its identity but loses the poisoned title; tab-2 has no
    // usable documentId and is dropped entirely.
    expect(tabs.map((t) => t.id)).toEqual(["tab-1"]);
    expect(tabs[0].title).toBe("");
  });

  it("truncates a stored tab set to the domain maximum and dedupes ids", async () => {
    const many = Array.from({ length: L.maxTabs + 5 }, (_, i) => tab({ id: `tab-${i}` }));
    const dupes = [tab({ id: "tab-dupe" }), tab({ id: "tab-dupe", title: "Second" })];

    const truncated = repo([row({ id: "s1", tabs: JSON.stringify(many) })]);
    expect((await truncated.subject.getByIdForUser("s1", "user-1"))!.tabs).toHaveLength(L.maxTabs);

    const deduped = repo([row({ id: "s2", tabs: JSON.stringify(dupes) })]);
    const tabs = (await deduped.subject.getByIdForUser("s2", "user-1"))!.tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].title).toBe("Report.pdf");
  });

  it("nulls activeTabId when the referenced tab did not survive validation", async () => {
    const { subject } = repo([
      row({ id: "s1", activeTabId: "tab-gone", tabs: JSON.stringify([tab({ id: "tab-ok" })]) }),
    ]);

    const session = await subject.getByIdForUser("s1", "user-1");
    expect(session!.activeTabId).toBeNull();
  });

  it("falls back to a sentinel date for unparseable timestamps", async () => {
    const stored = JSON.stringify([{ ...tab(), createdAt: "not-a-date", state: { lastAccessed: "nope" } }]);
    const { subject } = repo([row({ id: "s1", tabs: stored })]);

    const restored = (await subject.getByIdForUser("s1", "user-1"))!.tabs[0];
    expect(restored.createdAt.getTime()).toBe(0);
    expect(restored.state.lastAccessed.getTime()).toBe(0);
  });
});

/**
 * The two adapters back the same port, so TabService must behave identically
 * against either. These assert the observable contract matches.
 */
describe("WorkspaceSessionRepository — adapter parity", () => {
  it("agrees on scoping, idempotency and version behaviour", async () => {
    const prismaBacked = repo().subject;
    const memoryBacked = new InMemoryWorkspaceSessionRepository();

    for (const subject of [prismaBacked, memoryBacked]) {
      const input = {
        workspaceId: "ws-a",
        organizationId: "org-a",
        userId: "user-1",
        activeTabId: null,
        tabs: [],
      };

      const created = await subject.create(input);
      expect(created.version).toBe(1);
      expect(created.tabs).toEqual([]);
      expect(created.activeTabId).toBeNull();

      // Idempotent per (workspace, user).
      expect((await subject.create(input)).id).toBe(created.id);

      // Cross-user reads and writes are refused.
      expect(await subject.getByIdForUser(created.id, "user-2")).toBeNull();
      expect(await subject.update(created.id, "user-2", { activeTabId: null, tabs: [] })).toBeNull();
      expect(await subject.delete(created.id, "user-2")).toBe(false);

      // Stale version refused, matching version accepted once.
      expect(await subject.update(created.id, "user-1", { activeTabId: null, tabs: [] }, 99)).toBeNull();
      const bumped = await subject.update(created.id, "user-1", { activeTabId: null, tabs: [] }, 1);
      expect(bumped!.version).toBe(2);
      expect(bumped!.createdAt.getTime()).toBe(created.createdAt.getTime());

      expect(await subject.delete(created.id, "user-1")).toBe(true);
      expect(await subject.getByIdForUser(created.id, "user-1")).toBeNull();
    }
  });

  it("agrees on tab persistence", async () => {
    const prismaBacked = repo().subject;
    const memoryBacked = new InMemoryWorkspaceSessionRepository();
    const source = tab();

    for (const subject of [prismaBacked, memoryBacked]) {
      const created = await subject.create({
        workspaceId: "ws-a",
        organizationId: "org-a",
        userId: "user-1",
        activeTabId: source.id,
        tabs: [source],
      });

      expect(created.tabs).toHaveLength(1);
      expect(created.tabs[0].id).toBe(source.id);
      expect(created.tabs[0].documentId).toBe(source.documentId);
      expect(created.activeTabId).toBe(source.id);

      const cleared = await subject.update(created.id, "user-1", { activeTabId: null, tabs: [] });
      expect(cleared!.tabs).toEqual([]);
      expect(cleared!.activeTabId).toBeNull();
    }
  });
});
