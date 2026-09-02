import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { PrismaDocumentRecordRepository } from "./PrismaDocumentRecordRepository";

/**
 * The `update` contract, pinned at the adapter.
 *
 * `revision` in the patch is the EXPECTED CURRENT revision — a compare-and-swap
 * guard that goes into the WHERE clause — and the column is incremented by the
 * write. Nothing in the type signature says so, and a caller reading
 * `revision: number` reasonably assumes it is the value to store.
 *
 * One did. `VersionService.commit` passed `revision + 1`, which matched no row, so
 * every Workspace save after the first failed with "the version was written but
 * the document could not be advanced" — an orphaned version row and a save the
 * user could never complete. The service's own suite was green throughout,
 * because its fake repository spread the patch over the row instead of behaving
 * like this. These tests are the contract that fake now mirrors.
 */

interface Row {
  id: string;
  workspaceId: string;
  revision: number;
  currentVersionId: string | null;
  [key: string]: unknown;
}

function applyIncrement(current: number, op: unknown): number {
  if (op !== null && typeof op === "object" && "increment" in op) {
    return current + (op as { increment: number }).increment;
  }
  return typeof op === "number" ? op : current;
}

/** Honours `where` and `increment` the way the database does — that is the point. */
function client(rows: Row[]) {
  return {
    documentRecord: {
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
        const hit = rows.filter((row) => Object.entries(where).every(([k, v]) => row[k] === v));
        for (const row of hit) {
          for (const [k, v] of Object.entries(data)) {
            row[k] = k === "revision" ? applyIncrement(row.revision, v) : v;
          }
        }
        return { count: hit.length };
      },
      async findFirstOrThrow({ where }: { where: Record<string, unknown> }) {
        const row = rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
        if (!row) throw new Error("not found");
        return row;
      },
    },
  } as unknown as PrismaClient;
}

const row = (revision: number): Row => ({
  id: "doc-1",
  workspaceId: "ws-1",
  organizationId: "org-1",
  projectId: null,
  folderId: null,
  name: "Untitled PDF.pdf",
  normalizedName: "untitled pdf.pdf",
  lifecycleState: "active",
  orderKey: "a0",
  currentVersionId: null,
  favorite: false,
  lastAccessedAt: null,
  createdById: "user-1",
  revision,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  archivedAt: null,
  trashedAt: null,
  archivedById: null,
  trashedById: null,
});

describe("PrismaDocumentRecordRepository.update", () => {
  it("treats `revision` as the expected current value and increments the column", async () => {
    const rows = [row(2)];
    const repo = new PrismaDocumentRecordRepository(client(rows));

    const updated = await repo.update("ws-1", "doc-1", { currentVersionId: "ver-9", revision: 2 });

    expect(updated.currentVersionId).toBe("ver-9");
    // Not 2, and not 4: the caller's expected value plus the write's own increment.
    expect(updated.revision).toBe(3);
  });

  it("rejects a patch built on a revision the row has moved past", async () => {
    const rows = [row(3)];
    const repo = new PrismaDocumentRecordRepository(client(rows));

    await expect(repo.update("ws-1", "doc-1", { currentVersionId: "ver-9", revision: 2 })).rejects.toThrow(
      /conflict/i,
    );
    expect(rows[0].currentVersionId).toBeNull();
    expect(rows[0].revision).toBe(3);
  });

  it("passing the revision one wants to end up with matches nothing — the bug this pins", async () => {
    const rows = [row(2)];
    const repo = new PrismaDocumentRecordRepository(client(rows));

    // What `VersionService.commit` used to send for a document at revision 2.
    await expect(repo.update("ws-1", "doc-1", { currentVersionId: "ver-9", revision: 3 })).rejects.toThrow(
      /conflict/i,
    );
  });

  it("still updates unguarded patches, so a rename needs no revision", async () => {
    const rows = [row(5)];
    const repo = new PrismaDocumentRecordRepository(client(rows));

    const updated = await repo.update("ws-1", "doc-1", { name: "Contract.pdf" });

    expect(updated.name).toBe("Contract.pdf");
    expect(updated.revision).toBe(6);
  });

  it("scopes the write to the workspace, so an id alone cannot reach another tenant's row", async () => {
    const rows = [row(2)];
    const repo = new PrismaDocumentRecordRepository(client(rows));

    await expect(repo.update("ws-other", "doc-1", { currentVersionId: "ver-9" })).rejects.toThrow(/conflict/i);
    expect(rows[0].currentVersionId).toBeNull();
  });
});
