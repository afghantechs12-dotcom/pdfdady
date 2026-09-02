import { describe, expect, it } from "vitest";
import { PrismaDocumentStatisticsRepository } from "./PrismaDocumentStatisticsRepository";
import type { PrismaClient } from "@prisma/client";
import { STATISTICS_LIMITS, emptyCounts } from "@/src/domain/entities/DocumentStatistics";
import type { StatisticsCounts } from "@/src/domain/entities/DocumentStatistics";
import type { UpsertDocumentStatisticsInput } from "@/src/application/ports/workspaces/DocumentStatisticsRepository";

interface StatsRow {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  versionId: string;
  schemaVersion: number;
  counts: string;
  checksum: string;
  status: string;
  error: string | null;
  calculatedAt: Date | null;
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
  if (actual instanceof Date && expected instanceof Date) {
    return actual.getTime() === expected.getTime();
  }
  return actual === expected;
}

/**
 * Applies only the predicates the adapter actually supplied.
 *
 * That is the point of the fake: if the adapter ever drops `workspaceId` from a
 * `where` clause, this matcher stops filtering on it and the cross-tenant tests
 * below fail — rather than passing because the fake helpfully scoped the query
 * on the adapter's behalf.
 */
function matches(row: StatsRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => matchValue(row[k as keyof StatsRow], v));
}

function fakePrisma(rows: StatsRow[]) {
  let seq = 0;
  const wheres: Record<string, unknown>[] = [];
  const takes: Array<number | undefined> = [];

  const delegate = {
    async upsert({
      where,
      create,
      update,
    }: {
      where: Record<string, unknown>;
      create: Partial<StatsRow>;
      update: Record<string, unknown>;
    }) {
      wheres.push(where);
      const existing = rows.find((r) => matches(r, where));
      if (existing) {
        seq += 1;
        if ("schemaVersion" in update) existing.schemaVersion = update.schemaVersion as number;
        if ("counts" in update) existing.counts = update.counts as string;
        if ("checksum" in update) existing.checksum = update.checksum as string;
        if ("status" in update) existing.status = update.status as string;
        if ("error" in update) existing.error = update.error as string | null;
        if ("calculatedAt" in update) existing.calculatedAt = update.calculatedAt as Date | null;
        if ("revision" in update) existing.revision = applyIncrement(existing.revision, update.revision);
        existing.updatedAt = new Date(Date.UTC(2026, 7, 4, 12, 0, seq));
        return existing;
      }
      seq += 1;
      const now = new Date(Date.UTC(2026, 7, 4, 12, 0, seq));
      const row: StatsRow = {
        id: `stats-${seq}`,
        organizationId: create.organizationId!,
        workspaceId: create.workspaceId!,
        documentId: create.documentId!,
        versionId: create.versionId!,
        schemaVersion: create.schemaVersion ?? 1,
        counts: create.counts ?? "{}",
        checksum: create.checksum ?? "",
        status: create.status ?? "pending",
        error: create.error ?? null,
        calculatedAt: create.calculatedAt ?? null,
        revision: 1,
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
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
      return take === undefined ? found : found.slice(0, take);
    },
    async deleteMany({ where }: { where: Record<string, unknown> }) {
      wheres.push(where);
      const keep = rows.filter((r) => !matches(r, where));
      const removed = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count: removed };
    },
  };

  return { prisma: { documentStatistics: delegate } as unknown as PrismaClient, wheres, takes };
}

function counts(overrides: Partial<StatisticsCounts> = {}): StatisticsCounts {
  return {
    pageCount: 5,
    textCharacterCount: 1200,
    wordCount: 220,
    imageCount: 3,
    annotationCount: 1,
    bookmarkCount: 2,
    attachmentCount: 0,
    fileSize: 40960,
    ...overrides,
  };
}

function draft(overrides: Partial<UpsertDocumentStatisticsInput> = {}): UpsertDocumentStatisticsInput {
  return {
    organizationId: "org-1",
    workspaceId: "ws-1",
    documentId: "doc-1",
    versionId: "ver-1",
    schemaVersion: STATISTICS_LIMITS.schemaVersion,
    counts: counts(),
    checksum: "c".repeat(64),
    status: "ready",
    error: null,
    calculatedAt: new Date("2026-08-04T10:00:00.000Z"),
    ...overrides,
  };
}

describe("PrismaDocumentStatisticsRepository", () => {
  it("keeps one row per version", async () => {
    const rows: StatsRow[] = [];
    const repo = new PrismaDocumentStatisticsRepository(fakePrisma(rows).prisma);

    await repo.upsert(draft());
    await repo.upsert(draft({ checksum: "d".repeat(64) }));

    expect(rows).toHaveLength(1);
  });

  it("scopes get by Workspace", async () => {
    const rows: StatsRow[] = [];
    const repo = new PrismaDocumentStatisticsRepository(fakePrisma(rows).prisma);
    await repo.upsert(draft());

    expect(await repo.getByVersionId("ws-1", "ver-1")).not.toBeNull();
    // Another tenant's row reads as missing, not as forbidden.
    expect(await repo.getByVersionId("ws-other", "ver-1")).toBeNull();
  });

  it("scopes the listing by Workspace and document", async () => {
    const rows: StatsRow[] = [];
    const repo = new PrismaDocumentStatisticsRepository(fakePrisma(rows).prisma);
    await repo.upsert(draft({ versionId: "ver-1" }));
    await repo.upsert(draft({ versionId: "ver-2" }));
    await repo.upsert(draft({ versionId: "ver-3", workspaceId: "ws-other" }));
    await repo.upsert(draft({ versionId: "ver-4", documentId: "doc-2" }));

    const listed = await repo.listForDocument("ws-1", "doc-1", 25);
    expect(listed).toHaveLength(2);
    expect(listed.every((r) => r.workspaceId === "ws-1" && r.documentId === "doc-1")).toBe(true);
  });

  it("bounds the listing at the domain cap", async () => {
    const rows: StatsRow[] = [];
    const { prisma, takes } = fakePrisma(rows);
    const repo = new PrismaDocumentStatisticsRepository(prisma);

    await repo.listForDocument("ws-1", "doc-1", 10_000);
    expect(takes.at(-1)).toBe(STATISTICS_LIMITS.maxListLimit);
  });

  it("round-trips serialized counts", async () => {
    const rows: StatsRow[] = [];
    const repo = new PrismaDocumentStatisticsRepository(fakePrisma(rows).prisma);
    await repo.upsert(draft({ counts: counts({ pageCount: 42, wordCount: 0 }) }));

    const read = await repo.getByVersionId("ws-1", "ver-1");
    expect(read?.counts.pageCount).toBe(42);
    // A measured zero survives as zero rather than degrading to "not measured".
    expect(read?.counts.wordCount).toBe(0);
  });

  it("degrades invalid serialized counts safely", async () => {
    const rows: StatsRow[] = [];
    const repo = new PrismaDocumentStatisticsRepository(fakePrisma(rows).prisma);
    await repo.upsert(draft());
    rows[0].counts = "{not json at all";

    const read = await repo.getByVersionId("ws-1", "ver-1");
    // Losing a count is recoverable; refusing to open the panel is not.
    expect(read?.counts).toEqual(emptyCounts());
  });

  it("degrades an unknown status safely", async () => {
    const rows: StatsRow[] = [];
    const repo = new PrismaDocumentStatisticsRepository(fakePrisma(rows).prisma);
    await repo.upsert(draft());
    rows[0].status = "quantum";

    const read = await repo.getByVersionId("ws-1", "ver-1");
    // Not trusted as ready: a status this build does not know is not a promise
    // that the numbers are current.
    expect(read?.status).toBe("pending");
  });

  it("preserves the checksum and a bounded error", async () => {
    const rows: StatsRow[] = [];
    const repo = new PrismaDocumentStatisticsRepository(fakePrisma(rows).prisma);
    const stored = await repo.upsert(
      draft({ status: "failed", error: "extraction failed", checksum: "e".repeat(64) }),
    );

    expect(stored.checksum).toBe("e".repeat(64));
    expect(stored.error).toBe("extraction failed");
  });

  it("converges on upsert rather than accumulating", async () => {
    const rows: StatsRow[] = [];
    const repo = new PrismaDocumentStatisticsRepository(fakePrisma(rows).prisma);
    const first = await repo.upsert(draft());
    const second = await repo.upsert(draft({ counts: counts({ pageCount: 9 }) }));

    expect(second.id).toBe(first.id);
    expect(second.counts.pageCount).toBe(9);
  });

  it("increments the revision on update", async () => {
    const rows: StatsRow[] = [];
    const repo = new PrismaDocumentStatisticsRepository(fakePrisma(rows).prisma);
    const first = await repo.upsert(draft());
    const second = await repo.upsert(draft({ checksum: "f".repeat(64) }));

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
  });

  it("preserves createdAt across updates", async () => {
    const rows: StatsRow[] = [];
    const repo = new PrismaDocumentStatisticsRepository(fakePrisma(rows).prisma);
    const first = await repo.upsert(draft());
    const second = await repo.upsert(draft({ checksum: "f".repeat(64) }));

    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
  });

  it("advances updatedAt on update", async () => {
    const rows: StatsRow[] = [];
    const repo = new PrismaDocumentStatisticsRepository(fakePrisma(rows).prisma);
    const first = await repo.upsert(draft());
    const second = await repo.upsert(draft({ checksum: "f".repeat(64) }));

    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
  });

  it("scopes delete by Workspace", async () => {
    const rows: StatsRow[] = [];
    const repo = new PrismaDocumentStatisticsRepository(fakePrisma(rows).prisma);
    await repo.upsert(draft());

    expect(await repo.delete("ws-other", "ver-1")).toBe(false);
    expect(rows).toHaveLength(1);
    expect(await repo.delete("ws-1", "ver-1")).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("scopes deleteForDocument by Workspace", async () => {
    const rows: StatsRow[] = [];
    const repo = new PrismaDocumentStatisticsRepository(fakePrisma(rows).prisma);
    await repo.upsert(draft({ versionId: "ver-1" }));
    await repo.upsert(draft({ versionId: "ver-2" }));
    await repo.upsert(draft({ versionId: "ver-3", workspaceId: "ws-other" }));

    expect(await repo.deleteForDocument("ws-other-still", "doc-1")).toBe(0);
    expect(await repo.deleteForDocument("ws-1", "doc-1")).toBe(2);
    // The other tenant's row is untouched.
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe("ws-other");
  });

  it("returns objects that cannot mutate stored rows", async () => {
    const rows: StatsRow[] = [];
    const repo = new PrismaDocumentStatisticsRepository(fakePrisma(rows).prisma);
    const stored = await repo.upsert(draft());

    stored.counts.pageCount = 9999;
    stored.calculatedAt?.setFullYear(1999);

    const reread = await repo.getByVersionId("ws-1", "ver-1");
    expect(reread?.counts.pageCount).toBe(5);
    expect(reread?.calculatedAt?.getFullYear()).toBe(2026);
  });
});
