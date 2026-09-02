import { describe, expect, it } from "vitest";
import { PrismaDocumentPermissionGrantRepository } from "./PrismaDocumentPermissionGrantRepository";
import type { PrismaClient } from "@prisma/client";
import { COLLABORATION_LIMITS } from "@/src/domain/entities/Collaboration";
import type { CreateDocumentPermissionGrantInput } from "@/src/application/ports/workspaces/DocumentPermissionGrantRepository";

interface GrantRow {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  granteeUserId: string;
  role: string;
  grantedById: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedById: string | null;
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

function matchScalar(actual: unknown, expected: unknown): boolean {
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

/** Supports the one OR form the adapter uses: "no expiry, or not yet expired". */
function matches(row: GrantRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") {
      const clauses = value as Array<Record<string, unknown>>;
      return clauses.some((clause) => matches(row, clause));
    }
    return matchScalar(row[key as keyof GrantRow], value);
  });
}

function fakePrisma(rows: GrantRow[]) {
  let seq = 0;
  const wheres: Record<string, unknown>[] = [];
  const takes: Array<number | undefined> = [];

  const delegate = {
    async create({ data }: { data: Partial<GrantRow> }) {
      seq += 1;
      const now = new Date(Date.UTC(2026, 7, 3, 12, 0, seq));
      const row: GrantRow = {
        id: `gr-${seq}`,
        organizationId: data.organizationId!,
        workspaceId: data.workspaceId!,
        documentId: data.documentId!,
        granteeUserId: data.granteeUserId!,
        role: data.role ?? "viewer",
        grantedById: data.grantedById!,
        expiresAt: data.expiresAt ?? null,
        revokedAt: null,
        revokedById: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(row);
      return row;
    },
    async findFirst({ where }: { where: Record<string, unknown> }) {
      wheres.push(where);
      return (
        rows
          .filter((r) => matches(r, where))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null
      );
    },
    async findMany({ where, take }: { where: Record<string, unknown>; take?: number }) {
      wheres.push(where);
      takes.push(take);
      const found = rows
        .filter((r) => matches(r, where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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
        if ("role" in data) row.role = data.role as string;
        if ("expiresAt" in data) row.expiresAt = data.expiresAt as Date | null;
        if ("revokedAt" in data) row.revokedAt = data.revokedAt as Date;
        if ("revokedById" in data) row.revokedById = data.revokedById as string;
        if ("revision" in data) row.revision = applyIncrement(row.revision, data.revision);
      }
      return { count: found.length };
    },
    async count({ where }: { where: Record<string, unknown> }) {
      wheres.push(where);
      return rows.filter((r) => matches(r, where)).length;
    },
  };

  return {
    prisma: { documentPermissionGrant: delegate } as unknown as PrismaClient,
    wheres,
    takes,
  };
}

const NOW = new Date("2026-08-03T12:30:00.000Z");

function draft(
  overrides: Partial<CreateDocumentPermissionGrantInput> = {},
): CreateDocumentPermissionGrantInput {
  return {
    organizationId: "org-1",
    workspaceId: "ws-1",
    documentId: "doc-1",
    granteeUserId: "user-guest",
    role: "viewer",
    grantedById: "user-owner",
    expiresAt: null,
    ...overrides,
  };
}

describe("PrismaDocumentPermissionGrantRepository", () => {
  it("persists every supplied field", async () => {
    const rows: GrantRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaDocumentPermissionGrantRepository(prisma);

    const grant = await repo.create(draft({ role: "commenter" }));
    expect(grant.documentId).toBe("doc-1");
    expect(grant.granteeUserId).toBe("user-guest");
    expect(grant.role).toBe("commenter");
    expect(grant.grantedById).toBe("user-owner");
    expect(grant.revokedAt).toBeNull();
    expect(grant.revision).toBe(1);
  });

  it("scopes every read by Workspace", async () => {
    const rows: GrantRow[] = [];
    const { prisma, wheres } = fakePrisma(rows);
    const repo = new PrismaDocumentPermissionGrantRepository(prisma);
    const grant = await repo.create(draft());
    expect(await repo.getById("ws-other", grant.id)).toBeNull();
    expect(await repo.getById("ws-1", grant.id)).not.toBeNull();
    expect(wheres.every((w) => "workspaceId" in w)).toBe(true);
  });

  it("finds an active grant and excludes a revoked one", async () => {
    const rows: GrantRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaDocumentPermissionGrantRepository(prisma);
    const grant = await repo.create(draft({ role: "commenter" }));

    expect(await repo.findActiveForUser("ws-1", "doc-1", "user-guest", NOW)).not.toBeNull();
    await repo.revoke("ws-1", grant.id, "user-owner", NOW);
    expect(await repo.findActiveForUser("ws-1", "doc-1", "user-guest", NOW)).toBeNull();
  });

  it("excludes an expired grant without any sweep job", async () => {
    // Expiry is a predicate, not a scheduled cleanup: it takes effect the
    // instant it passes, whether or not anything ran in between.
    const rows: GrantRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaDocumentPermissionGrantRepository(prisma);
    const expiresAt = new Date(NOW.getTime() + 60_000);
    await repo.create(draft({ expiresAt }));

    expect(await repo.findActiveForUser("ws-1", "doc-1", "user-guest", NOW)).not.toBeNull();
    expect(
      await repo.findActiveForUser("ws-1", "doc-1", "user-guest", new Date(expiresAt.getTime() + 1)),
    ).toBeNull();
  });

  it("returns the strongest live grant when several exist", async () => {
    // Revoking one of two shares must not leave the weaker one silently deciding.
    const rows: GrantRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaDocumentPermissionGrantRepository(prisma);
    await repo.create(draft({ role: "viewer" }));
    await repo.create(draft({ role: "editor" }));
    const active = await repo.findActiveForUser("ws-1", "doc-1", "user-guest", NOW);
    expect(active?.role).toBe("editor");
  });

  it("does not find a grant issued on another document or for another user", async () => {
    const rows: GrantRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaDocumentPermissionGrantRepository(prisma);
    await repo.create(draft());
    expect(await repo.findActiveForUser("ws-1", "doc-2", "user-guest", NOW)).toBeNull();
    expect(await repo.findActiveForUser("ws-1", "doc-1", "user-other", NOW)).toBeNull();
    expect(await repo.findActiveForUser("ws-other", "doc-1", "user-guest", NOW)).toBeNull();
  });

  it("degrades an unknown stored role to the weakest one", async () => {
    // An unknown role must never read as *more* access than we understand.
    const rows: GrantRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaDocumentPermissionGrantRepository(prisma);
    const grant = await repo.create(draft());
    rows[0].role = "superuser";
    const reread = await repo.getById("ws-1", grant.id);
    expect(reread?.role).toBe("viewer");
  });

  it("refuses to update a revoked grant", async () => {
    // Re-arming a revoked grant through an edit is the escalation revocation
    // exists to prevent.
    const rows: GrantRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaDocumentPermissionGrantRepository(prisma);
    const grant = await repo.create(draft());
    const revoked = await repo.revoke("ws-1", grant.id, "user-owner", NOW);
    expect(
      await repo.update("ws-1", grant.id, revoked!.revision, { role: "editor", expiresAt: null }),
    ).toBeNull();
  });

  it("updates role and expiry on a matching revision only", async () => {
    const rows: GrantRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaDocumentPermissionGrantRepository(prisma);
    const grant = await repo.create(draft());

    expect(await repo.update("ws-1", grant.id, 99, { role: "editor" })).toBeNull();

    const expiresAt = new Date(NOW.getTime() + 3600_000);
    const updated = await repo.update("ws-1", grant.id, grant.revision, {
      role: "editor",
      expiresAt,
    });
    expect(updated?.role).toBe("editor");
    expect(updated?.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  it("leaves the original timestamp in place when revoked twice", async () => {
    const rows: GrantRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaDocumentPermissionGrantRepository(prisma);
    const grant = await repo.create(draft());
    const first = await repo.revoke("ws-1", grant.id, "user-owner", NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const second = await repo.revoke("ws-1", grant.id, "user-other", later);
    // The moment access was withdrawn is the fact worth keeping.
    expect(second?.revokedAt?.getTime()).toBe(first?.revokedAt?.getTime());
    expect(second?.revokedById).toBe("user-owner");
  });

  it("refuses a cross-Workspace revoke", async () => {
    const rows: GrantRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaDocumentPermissionGrantRepository(prisma);
    const grant = await repo.create(draft());
    expect(await repo.revoke("ws-other", grant.id, "user-x", NOW)).toBeNull();
    expect(rows[0].revokedAt).toBeNull();
  });

  it("retains revoked grants but excludes them from an active listing", async () => {
    const rows: GrantRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaDocumentPermissionGrantRepository(prisma);
    const grant = await repo.create(draft());
    await repo.revoke("ws-1", grant.id, "user-owner", NOW);

    const active = await repo.list({
      workspaceId: "ws-1",
      documentId: "doc-1",
      activeOnly: true,
      limit: 10,
    });
    expect(active).toHaveLength(0);
    // "Who could see this, and until when" is an audit question.
    const all = await repo.list({ workspaceId: "ws-1", documentId: "doc-1", limit: 10 });
    expect(all).toHaveLength(1);
  });

  it("clamps a listing to the domain cap", async () => {
    const rows: GrantRow[] = [];
    const { prisma, takes } = fakePrisma(rows);
    const repo = new PrismaDocumentPermissionGrantRepository(prisma);
    await repo.create(draft());
    await repo.list({ workspaceId: "ws-1", documentId: "doc-1", limit: 100_000 });
    expect(takes.at(-1)).toBe(COLLABORATION_LIMITS.maxListLimit);
  });

  it("counts only active grants for a document", async () => {
    const rows: GrantRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaDocumentPermissionGrantRepository(prisma);
    const first = await repo.create(draft({ granteeUserId: "user-a" }));
    await repo.create(draft({ granteeUserId: "user-b" }));
    await repo.create(draft({ granteeUserId: "user-c", expiresAt: new Date(NOW.getTime() - 1) }));
    await repo.revoke("ws-1", first.id, "user-owner", NOW);

    expect(await repo.countActiveForDocument("ws-1", "doc-1", NOW)).toBe(1);
  });

  it("finds a live grant regardless of expiry, for convergence", async () => {
    // findLiveForUser is about "is there a row to update", not "does it confer
    // access" — an expired-but-unrevoked share is still the row to re-point.
    const rows: GrantRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaDocumentPermissionGrantRepository(prisma);
    await repo.create(draft({ expiresAt: new Date(NOW.getTime() - 1000) }));
    expect(await repo.findLiveForUser("ws-1", "doc-1", "user-guest")).not.toBeNull();
    expect(await repo.findActiveForUser("ws-1", "doc-1", "user-guest", NOW)).toBeNull();
  });

  it("returns independent date objects on every read", async () => {
    const rows: GrantRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaDocumentPermissionGrantRepository(prisma);
    const grant = await repo.create(draft());
    grant.createdAt.setFullYear(1999);
    const reread = await repo.getById("ws-1", grant.id);
    expect(reread?.createdAt.getFullYear()).not.toBe(1999);
  });
});
