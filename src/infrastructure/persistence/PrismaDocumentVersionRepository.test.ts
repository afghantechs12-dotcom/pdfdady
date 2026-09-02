import { describe, expect, it } from "vitest";
import { PrismaDocumentVersionRepository } from "./PrismaDocumentVersionRepository";
import { InMemoryDocumentVersionRepository } from "./InMemoryDocumentVersionRepository";
import type { PrismaClient } from "@prisma/client";
import type { CreateDocumentVersionInput } from "@/src/application/ports/workspaces/DocumentVersionRepository";
import { DOCUMENT_VERSION_LIMITS as L } from "@/src/domain/entities/DocumentVersion";

/**
 * Row-backed stand-in for the `documentVersion` delegate.
 *
 * The fake resolves `where` generically and enforces the real
 * (documentId, versionNumber) unique constraint, so the adapter's own predicates,
 * its transactional number allocation and its retry-on-collision loop are what
 * the assertions actually exercise — a predicate the adapter forgets to send is a
 * predicate that simply does not filter, and the test fails.
 */
interface Row {
  id: string;
  workspaceId: string;
  organizationId: string;
  documentId: string;
  versionNumber: number;
  revision: number;
  origin: string;
  restoredFromVersionId: string | null;
  label: string | null;
  manifest: string;
  checksum: string;
  createdById: string;
  createdAt: Date;
}

type Operators = { lt?: number; not?: string; contains?: string };

function matchValue(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !(expected instanceof Date)) {
    const ops = expected as Operators;
    if ("lt" in ops) return typeof actual === "number" && actual < (ops.lt as number);
    if ("not" in ops) return actual !== ops.not;
    if ("contains" in ops) {
      return typeof actual === "string" && actual.includes(ops.contains as string);
    }
    return false;
  }
  return actual === expected;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => matchValue(row[key as keyof Row], value));
}

function uniqueViolation(): Error {
  const error = new Error("Unique constraint failed on the fields: (`documentId`,`versionNumber`)");
  (error as Error & { code: string }).code = "P2002";
  return error;
}

function fakePrisma(rows: Row[]) {
  let seq = 0;
  const stats = { creates: 0, transactions: 0 };
  /** Runs once, just before the next insert — simulates a concurrent writer. */
  let beforeNextCreate: (() => void) | null = null;
  let alwaysCollide = false;
  let failWith: Error | null = null;

  const delegate = {
    async findFirst({
      where,
      orderBy,
    }: {
      where: Record<string, unknown>;
      orderBy?: { versionNumber: "asc" | "desc" };
      select?: unknown;
    }) {
      const found = rows.filter((r) => matches(r, where));
      if (orderBy?.versionNumber === "desc") {
        found.sort((a, b) => b.versionNumber - a.versionNumber);
      }
      return found[0] ?? null;
    },
    async findMany({
      where,
      orderBy,
      take,
    }: {
      where: Record<string, unknown>;
      orderBy?: { versionNumber: "asc" | "desc" };
      take?: number;
      select?: unknown;
    }) {
      const found = rows.filter((r) => matches(r, where));
      if (orderBy?.versionNumber === "desc") {
        found.sort((a, b) => b.versionNumber - a.versionNumber);
      }
      return take === undefined ? found : found.slice(0, take);
    },
    async create({ data }: { data: Partial<Row> }) {
      stats.creates += 1;
      if (failWith) throw failWith;
      if (beforeNextCreate) {
        const hook = beforeNextCreate;
        beforeNextCreate = null;
        hook();
      }
      if (
        alwaysCollide ||
        rows.some(
          (r) => r.documentId === data.documentId && r.versionNumber === data.versionNumber,
        )
      ) {
        throw uniqueViolation();
      }
      seq += 1;
      const created: Row = {
        id: `version-${seq}`,
        workspaceId: data.workspaceId!,
        organizationId: data.organizationId!,
        documentId: data.documentId!,
        versionNumber: data.versionNumber!,
        revision: data.revision ?? 0,
        origin: data.origin ?? "save",
        restoredFromVersionId: data.restoredFromVersionId ?? null,
        label: data.label ?? null,
        manifest: data.manifest ?? "",
        checksum: data.checksum ?? "",
        createdById: data.createdById!,
        createdAt: new Date(),
      };
      rows.push(created);
      return created;
    },
    async count({ where }: { where: Record<string, unknown> }) {
      return rows.filter((r) => matches(r, where)).length;
    },
    async deleteMany({ where }: { where: Record<string, unknown> }) {
      const keep = rows.filter((r) => !matches(r, where));
      const count = rows.length - keep.length;
      rows.length = 0;
      rows.push(...keep);
      return { count };
    },
  };

  return {
    rows,
    stats,
    documentVersion: delegate,
    async $transaction<T>(fn: (tx: { documentVersion: typeof delegate }) => Promise<T>): Promise<T> {
      stats.transactions += 1;
      return fn({ documentVersion: delegate });
    },
    /** Injects a competing insert between the max-read and the adapter's insert. */
    raceOnce(row: Row) {
      beforeNextCreate = () => rows.push(row);
    },
    collideAlways() {
      alwaysCollide = true;
    },
    failCreatesWith(error: Error) {
      failWith = error;
    },
  };
}

function repo(rows: Row[] = []) {
  const prisma = fakePrisma(rows);
  return {
    prisma,
    subject: new PrismaDocumentVersionRepository(prisma as unknown as PrismaClient),
  };
}

function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 1,
    sourceKey: "workspaces/ws-a/sources/doc-1/v1.pdf",
    sourceChecksum: "a".repeat(64),
    sourceByteSize: 2048,
    editorStateKey: null,
    editorStateChecksum: null,
    outputKey: null,
    outputChecksum: null,
    pageCount: 3,
    thumbnailKeys: ["workspaces/ws-a/thumbs/doc-1/1.png"],
    ...overrides,
  });
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "version-seed",
    workspaceId: "ws-a",
    organizationId: "org-a",
    documentId: "doc-1",
    versionNumber: 1,
    revision: 1,
    origin: "save",
    restoredFromVersionId: null,
    label: null,
    manifest: manifestJson(),
    checksum: "b".repeat(64),
    createdById: "user-1",
    createdAt: new Date("2026-08-02T10:00:00.000Z"),
    ...overrides,
  };
}

function createInput(overrides: Partial<CreateDocumentVersionInput> = {}): CreateDocumentVersionInput {
  return {
    workspaceId: "ws-a",
    organizationId: "org-a",
    documentId: "doc-1",
    revision: 1,
    origin: "save",
    restoredFromVersionId: null,
    label: null,
    manifest: manifestJson(),
    checksum: "b".repeat(64),
    createdById: "user-1",
    ...overrides,
  };
}

describe("PrismaDocumentVersionRepository — transactional allocation", () => {
  it("allocates the first version number as 1", async () => {
    const { subject } = repo();
    const created = await subject.create(createInput());

    expect(created.versionNumber).toBe(1);
  });

  it("allocates inside a transaction, not around one", async () => {
    const { subject, prisma } = repo();
    await subject.create(createInput());

    // Reading the maximum outside the transaction is exactly the lost update the
    // unique index exists to stop; the read must happen within it.
    expect(prisma.stats.transactions).toBe(1);
  });

  it("continues the sequence from the document's existing maximum", async () => {
    const { subject } = repo([row({ id: "v1", versionNumber: 1 }), row({ id: "v2", versionNumber: 2 })]);
    const created = await subject.create(createInput());

    expect(created.versionNumber).toBe(3);
  });

  it("numbers each document independently", async () => {
    const { subject } = repo([row({ id: "v1", documentId: "doc-1", versionNumber: 7 })]);
    const created = await subject.create(createInput({ documentId: "doc-2" }));

    expect(created.versionNumber).toBe(1);
  });

  it("retries and takes the next number when a concurrent writer wins the race", async () => {
    const { subject, prisma } = repo();
    // A competing save lands version 1 after this call read the maximum.
    prisma.raceOnce(row({ id: "rival", versionNumber: 1 }));

    const created = await subject.create(createInput());

    // Not 1 (that number is taken) and not skipped to 3: the retry re-reads the
    // authoritative maximum rather than reusing the stale one it started with.
    expect(created.versionNumber).toBe(2);
    expect(prisma.stats.creates).toBe(2);
  });

  it("never issues a duplicate number under repeated contention", async () => {
    const { subject, prisma } = repo();
    await subject.create(createInput());
    prisma.raceOnce(row({ id: "rival", versionNumber: 2 }));
    await subject.create(createInput());
    await subject.create(createInput());

    const numbers = prisma.rows
      .filter((r) => r.documentId === "doc-1")
      .map((r) => r.versionNumber)
      .sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4]);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("gives up after the bounded number of attempts rather than looping forever", async () => {
    const { subject, prisma } = repo();
    prisma.collideAlways();

    await expect(subject.create(createInput())).rejects.toThrow(/Unique constraint/);
    expect(prisma.stats.creates).toBe(L.maxAllocationAttempts);
  });

  it("does not retry a failure that is not a number collision", async () => {
    const { subject, prisma } = repo();
    prisma.failCreatesWith(new Error("database is offline"));

    await expect(subject.create(createInput())).rejects.toThrow(/database is offline/);
    // Retrying a real failure would turn one error into a slow timeout.
    expect(prisma.stats.creates).toBe(1);
  });

  it("stores the caller's provenance and tenancy verbatim", async () => {
    const { subject } = repo();
    const created = await subject.create(
      createInput({ origin: "restore", restoredFromVersionId: "version-9", label: "Checkpoint" }),
    );

    expect(created.origin).toBe("restore");
    expect(created.restoredFromVersionId).toBe("version-9");
    expect(created.label).toBe("Checkpoint");
    expect(created.organizationId).toBe("org-a");
  });

  it("truncates an oversized label on write rather than storing it", async () => {
    const { subject, prisma } = repo();
    await subject.create(createInput({ label: "x".repeat(L.maxLabelLength + 50) }));

    expect(prisma.rows[0].label).toHaveLength(L.maxLabelLength);
  });
});

describe("PrismaDocumentVersionRepository — tenant scoping", () => {
  it("never returns a version from another Workspace", async () => {
    const { subject } = repo([row({ id: "v1", workspaceId: "ws-a" })]);

    expect(await subject.getById("ws-a", "v1")).not.toBeNull();
    expect(await subject.getById("ws-b", "v1")).toBeNull();
  });

  it("resolves by number only within the addressed Workspace and document", async () => {
    const { subject } = repo([row({ id: "v1", versionNumber: 4 })]);

    expect(await subject.getByNumber("ws-a", "doc-1", 4)).not.toBeNull();
    expect(await subject.getByNumber("ws-b", "doc-1", 4)).toBeNull();
    expect(await subject.getByNumber("ws-a", "doc-2", 4)).toBeNull();
    expect(await subject.getByNumber("ws-a", "doc-1", 5)).toBeNull();
  });

  it("lists only the addressed Workspace's and document's versions", async () => {
    const { subject } = repo([
      row({ id: "v1", versionNumber: 1 }),
      row({ id: "v2", versionNumber: 2 }),
      row({ id: "other-ws", workspaceId: "ws-b", versionNumber: 3 }),
      row({ id: "other-doc", documentId: "doc-2", versionNumber: 3 }),
    ]);

    const listed = await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 50 });
    expect(listed.map((v) => v.id)).toEqual(["v2", "v1"]);
  });

  it("counts only the addressed Workspace's and document's versions", async () => {
    const { subject } = repo([
      row({ id: "v1", versionNumber: 1 }),
      row({ id: "v2", versionNumber: 2 }),
      row({ id: "other", workspaceId: "ws-b", versionNumber: 1 }),
    ]);

    expect(await subject.countForDocument("ws-a", "doc-1")).toBe(2);
    expect(await subject.countForDocument("ws-b", "doc-1")).toBe(1);
  });

  it("returns the highest-numbered version as the latest", async () => {
    const { subject } = repo([
      row({ id: "v1", versionNumber: 1 }),
      row({ id: "v3", versionNumber: 3 }),
      row({ id: "v2", versionNumber: 2 }),
    ]);

    expect((await subject.latest("ws-a", "doc-1"))!.id).toBe("v3");
    expect(await subject.latest("ws-b", "doc-1")).toBeNull();
  });

  it("deletes only within the addressed Workspace", async () => {
    const { subject, prisma } = repo([row({ id: "v1", workspaceId: "ws-a" })]);

    expect(await subject.delete("ws-b", "v1")).toBe(false);
    expect(prisma.rows).toHaveLength(1);
    expect(await subject.delete("ws-a", "v1")).toBe(true);
    expect(prisma.rows).toHaveLength(0);
    expect(await subject.delete("ws-a", "v1")).toBe(false);
  });
});

describe("PrismaDocumentVersionRepository — bounded reads", () => {
  it("orders history newest first", async () => {
    const { subject } = repo([
      row({ id: "v1", versionNumber: 1 }),
      row({ id: "v3", versionNumber: 3 }),
      row({ id: "v2", versionNumber: 2 }),
    ]);

    const listed = await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 50 });
    expect(listed.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
  });

  it("pages strictly below the given version number", async () => {
    const { subject } = repo([
      row({ id: "v1", versionNumber: 1 }),
      row({ id: "v2", versionNumber: 2 }),
      row({ id: "v3", versionNumber: 3 }),
    ]);

    const page = await subject.list({
      workspaceId: "ws-a",
      documentId: "doc-1",
      limit: 50,
      beforeVersionNumber: 3,
    });
    expect(page.map((v) => v.versionNumber)).toEqual([2, 1]);
  });

  it("caps a listing at the domain maximum however large a limit is asked for", async () => {
    const many = Array.from({ length: L.maxListLimit + 10 }, (_, i) =>
      row({ id: `v${i}`, versionNumber: i + 1 }),
    );
    const { subject } = repo(many);

    expect(
      await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 9_999 }),
    ).toHaveLength(L.maxListLimit);
    expect(
      await subject.list({
        workspaceId: "ws-a",
        documentId: "doc-1",
        limit: Number.POSITIVE_INFINITY,
      }),
    ).toHaveLength(L.maxListLimit);
  });

  it("returns one row for a nonsensical limit rather than everything", async () => {
    const { subject } = repo([
      row({ id: "v1", versionNumber: 1 }),
      row({ id: "v2", versionNumber: 2 }),
    ]);

    expect(await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 0 })).toHaveLength(1);
    expect(await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: -3 })).toHaveLength(1);
    expect(
      await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: Number.NaN }),
    ).toHaveLength(1);
  });

  it("degrades an unknown stored origin to a checkpoint", async () => {
    for (const bad of ["", "SAVE", "merge", "deleted"]) {
      const { subject } = repo([row({ id: "v1", origin: bad })]);
      // Never silently presented as a save, and never as a restore: a version of
      // unknown provenance must not claim a lineage it cannot prove.
      expect((await subject.getById("ws-a", "v1"))!.origin).toBe("checkpoint");
    }
  });

  it("passes through every legitimate origin unchanged", async () => {
    for (const origin of ["save", "restore", "import", "checkpoint"] as const) {
      const { subject } = repo([row({ id: "v1", origin })]);
      expect((await subject.getById("ws-a", "v1"))!.origin).toBe(origin);
    }
  });

  it("bounds nonsensical stored counters instead of surfacing them", async () => {
    const { subject } = repo([
      row({ id: "v1", versionNumber: Number.NaN, revision: -5 }),
    ]);

    const version = (await subject.getById("ws-a", "v1"))!;
    expect(version.versionNumber).toBe(0);
    expect(version.revision).toBe(0);
  });

  it("bounds an oversized stored label on read", async () => {
    const { subject } = repo([row({ id: "v1", label: "x".repeat(L.maxLabelLength + 50) })]);

    expect((await subject.getById("ws-a", "v1"))!.label).toHaveLength(L.maxLabelLength);
  });
});

describe("PrismaDocumentVersionRepository — manifest degradation", () => {
  it("degrades an unparseable manifest without dropping the version", async () => {
    const { subject } = repo([row({ id: "v1", manifest: "{not json" })]);

    const version = (await subject.getById("ws-a", "v1"))!;
    // The version keeps its place in history; pretending it has no artifacts
    // would misrepresent it as an empty checkpoint.
    expect(version).not.toBeNull();
    expect(version.manifestDegraded).toBe(true);
    expect(version.manifest.sourceKey).toBe("");
  });

  it("degrades a manifest that parses but is out of bounds", async () => {
    const { subject } = repo([
      row({ id: "v1", manifest: JSON.stringify({ sourceKey: "k", sourceChecksum: "zzz" }) }),
    ]);

    expect((await subject.getById("ws-a", "v1"))!.manifestDegraded).toBe(true);
  });

  it("degrades a manifest larger than the row bound", async () => {
    const oversized = JSON.stringify({ pad: "p".repeat(L.maxManifestBytes + 100) });
    const { subject } = repo([row({ id: "v1", manifest: oversized })]);

    expect((await subject.getById("ws-a", "v1"))!.manifestDegraded).toBe(true);
  });

  it("reads a well-formed manifest without degrading it", async () => {
    const { subject } = repo([row({ id: "v1" })]);

    const version = (await subject.getById("ws-a", "v1"))!;
    expect(version.manifestDegraded).toBe(false);
    expect(version.manifest.sourceKey).toBe("workspaces/ws-a/sources/doc-1/v1.pdf");
    expect(version.manifest.thumbnailKeys).toEqual(["workspaces/ws-a/thumbs/doc-1/1.png"]);
  });
});

describe("PrismaDocumentVersionRepository — artifact reference guard", () => {
  it("reports a key a version genuinely references", async () => {
    const { subject } = repo([row({ id: "v1" })]);

    expect(
      await subject.isArtifactReferenced("ws-a", "workspaces/ws-a/sources/doc-1/v1.pdf"),
    ).toBe(true);
    expect(
      await subject.isArtifactReferenced("ws-a", "workspaces/ws-a/thumbs/doc-1/1.png"),
    ).toBe(true);
  });

  it("does not report a key that merely appears inside another key", async () => {
    const stored = "workspaces/ws-a/archive/workspaces/ws-a/sources/doc-1/v1.pdf";
    const { subject } = repo([row({ id: "v1", manifest: manifestJson({ sourceKey: stored }) })]);

    // The stored key contains the queried one as a substring, so the database's
    // `contains` narrowing matches. Confirming against the parsed manifest is what
    // stops a false reference here — one that would leak the artifact forever by
    // never letting it be collected.
    expect(
      await subject.isArtifactReferenced("ws-a", "workspaces/ws-a/sources/doc-1/v1.pdf"),
    ).toBe(false);
  });

  it("scopes the reference check to the Workspace", async () => {
    const key = "workspaces/ws-a/sources/doc-1/v1.pdf";
    const { subject } = repo([row({ id: "v1", workspaceId: "ws-a" })]);

    expect(await subject.isArtifactReferenced("ws-a", key)).toBe(true);
    expect(await subject.isArtifactReferenced("ws-b", key)).toBe(false);
  });

  it("can exclude the version being pruned from the check", async () => {
    const key = "workspaces/ws-a/sources/doc-1/v1.pdf";
    const { subject } = repo([row({ id: "v1" })]);

    expect(await subject.isArtifactReferenced("ws-a", key, "v1")).toBe(false);
    expect(await subject.isArtifactReferenced("ws-a", key)).toBe(true);
  });

  it("sees a sibling version's reference to shared bytes", async () => {
    const key = "workspaces/ws-a/sources/doc-1/v1.pdf";
    const { subject } = repo([
      row({ id: "v1", versionNumber: 1 }),
      row({ id: "v2", versionNumber: 2 }),
    ]);

    // Deduplicated source bytes: pruning v1 must not strip what v2 still points at.
    expect(await subject.isArtifactReferenced("ws-a", key, "v1")).toBe(true);
  });

  it("treats an empty key as unreferenced rather than matching everything", async () => {
    const { subject } = repo([row({ id: "v1" })]);

    expect(await subject.isArtifactReferenced("ws-a", "")).toBe(false);
  });

  it("ignores a degraded version's unreadable manifest", async () => {
    const { subject } = repo([row({ id: "v1", manifest: "{not json" })]);

    expect(
      await subject.isArtifactReferenced("ws-a", "workspaces/ws-a/sources/doc-1/v1.pdf"),
    ).toBe(false);
  });
});

describe("PrismaDocumentVersionRepository — mutation isolation", () => {
  it("a returned version cannot be mutated into persisted state", async () => {
    const { subject } = repo([row({ id: "v1" })]);

    const first = (await subject.getById("ws-a", "v1"))!;
    first.label = "tampered";
    first.manifest.sourceKey = "attacker/key.pdf";
    first.manifest.thumbnailKeys.push("attacker/thumb.png");

    const second = (await subject.getById("ws-a", "v1"))!;
    expect(second.label).toBeNull();
    expect(second.manifest.sourceKey).toBe("workspaces/ws-a/sources/doc-1/v1.pdf");
    expect(second.manifest.thumbnailKeys).toHaveLength(1);
  });

  it("a returned date cannot be mutated into persisted state", async () => {
    const { subject } = repo([row({ id: "v1" })]);

    const version = (await subject.getById("ws-a", "v1"))!;
    const original = version.createdAt.getTime();
    version.createdAt.setFullYear(2099);

    expect((await subject.getById("ws-a", "v1"))!.createdAt.getTime()).toBe(original);
  });
});

/**
 * Both adapters back the same port, so VersionService must behave identically
 * against either. These pin the observable contract they share — the same class
 * of parity gap that the M7.5 adapter tests caught.
 */
describe("DocumentVersionRepository — adapter parity", () => {
  it("agrees on allocation, scoping and deletion", async () => {
    const prismaBacked = repo().subject;
    const memoryBacked = new InMemoryDocumentVersionRepository();

    for (const subject of [prismaBacked, memoryBacked]) {
      const first = await subject.create(createInput());
      const second = await subject.create(createInput());

      expect([first.versionNumber, second.versionNumber]).toEqual([1, 2]);
      expect(first.origin).toBe("save");
      expect(first.manifestDegraded).toBe(false);
      expect(first.restoredFromVersionId).toBeNull();

      // Reachable within its Workspace, invisible outside it.
      expect(await subject.getById("ws-a", first.id)).not.toBeNull();
      expect(await subject.getById("ws-b", first.id)).toBeNull();
      expect(await subject.getByNumber("ws-a", "doc-1", 1)).not.toBeNull();
      expect(await subject.getByNumber("ws-b", "doc-1", 1)).toBeNull();

      expect((await subject.latest("ws-a", "doc-1"))!.versionNumber).toBe(2);
      expect(await subject.countForDocument("ws-a", "doc-1")).toBe(2);
      expect(await subject.countForDocument("ws-b", "doc-1")).toBe(0);

      const key = "workspaces/ws-a/sources/doc-1/v1.pdf";
      expect(await subject.isArtifactReferenced("ws-a", key)).toBe(true);
      expect(await subject.isArtifactReferenced("ws-b", key)).toBe(false);
      expect(await subject.isArtifactReferenced("ws-a", key, first.id)).toBe(true);

      expect(await subject.delete("ws-b", first.id)).toBe(false);
      expect(await subject.delete("ws-a", first.id)).toBe(true);
      expect(await subject.delete("ws-a", first.id)).toBe(false);
      expect(await subject.getById("ws-a", first.id)).toBeNull();
    }
  });

  it("agrees that a version number is never reused after a delete", async () => {
    const prismaBacked = repo().subject;
    const memoryBacked = new InMemoryDocumentVersionRepository();

    for (const subject of [prismaBacked, memoryBacked]) {
      await subject.create(createInput());
      const second = await subject.create(createInput());
      await subject.delete("ws-a", second.id);

      // The next number continues from the surviving maximum. Reusing 2 would let
      // two different versions answer to the same number in one document's history.
      const third = await subject.create(createInput());
      expect(third.versionNumber).toBe(2);
      expect(third.id).not.toBe(second.id);
    }
  });

  it("agrees on manifest degradation for an unreadable row", async () => {
    const prismaBacked = repo().subject;
    const memoryBacked = new InMemoryDocumentVersionRepository();

    for (const subject of [prismaBacked, memoryBacked]) {
      const created = await subject.create(createInput({ manifest: "{not json" }));

      expect(created.manifestDegraded).toBe(true);
      expect(created.manifest.sourceKey).toBe("");
      expect((await subject.getById("ws-a", created.id))!.manifestDegraded).toBe(true);
    }
  });

  it("agrees on the listing bound and ordering", async () => {
    const prismaBacked = repo().subject;
    const memoryBacked = new InMemoryDocumentVersionRepository();

    for (const subject of [prismaBacked, memoryBacked]) {
      for (let i = 0; i < L.maxListLimit + 5; i += 1) {
        await subject.create(createInput());
      }

      expect(
        await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 9_999 }),
      ).toHaveLength(L.maxListLimit);
      expect(
        await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 0 }),
      ).toHaveLength(1);

      const page = await subject.list({
        workspaceId: "ws-a",
        documentId: "doc-1",
        limit: 3,
        beforeVersionNumber: 4,
      });
      expect(page.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
    }
  });

  it("agrees that a returned version cannot modify persisted state", async () => {
    const prismaBacked = repo().subject;
    const memoryBacked = new InMemoryDocumentVersionRepository();

    for (const subject of [prismaBacked, memoryBacked]) {
      const created = await subject.create(createInput({ label: "Original" }));
      created.label = "tampered";
      created.manifest.sourceKey = "attacker/key.pdf";
      created.createdAt.setFullYear(1990);

      const reread = (await subject.getById("ws-a", created.id))!;
      expect(reread.label).toBe("Original");
      expect(reread.manifest.sourceKey).toBe("workspaces/ws-a/sources/doc-1/v1.pdf");
      expect(reread.createdAt.getFullYear()).toBeGreaterThan(2000);
    }
  });
});
