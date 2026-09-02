import { describe, expect, it } from "vitest";
import {
  FakeIndexedDb,
  installKeyRange,
  manualTimers,
} from "@/src/infrastructure/persistence/browser/testing/fakeIndexedDb";
import { IndexedDbKeyValueStore } from "@/src/infrastructure/persistence/browser/IndexedDbKeyValueStore";
import {
  HANDOFF_MAX_BYTES,
  HANDOFF_TTL_MS,
  HandoffError,
  claimHandoff,
  createHandoff,
  handoffFile,
  handoffKey,
  isExpired,
  parseHandoff,
  sweepHandoffs,
} from "./handoff";

/**
 * T2 (byte half) — the tool → editor handoff.
 *
 * The defect this replaces is a user experience, not a crash: the only way to move
 * a merge result into the editor was to download it, find it in Downloads, and
 * upload it again. So the properties worth pinning are the ones that make the
 * shortcut trustworthy — the bytes arrive unchanged, the name arrives unchanged,
 * a claimed handoff is GONE, and an old one is refused rather than opened over
 * whatever the user is editing now.
 *
 * The store is the real adapter over the existing IndexedDB fake: a hand-written
 * `KeyValueStore` double would pass while the actual structured-clone round trip
 * (which is what carries a `Uint8Array`) was broken.
 */
const PROVENANCE = {
  toolSlug: "merge-pdf",
  sourceFileNames: ["contract.pdf", "appendix.pdf"],
  workspaceId: null,
  sourceDocumentId: null,
} as const;

const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);

function setup() {
  const fake = new FakeIndexedDb();
  const timers = manualTimers();
  const restore = installKeyRange();
  const db = new IndexedDbKeyValueStore({
    factory: fake as unknown as IDBFactory,
    databaseName: "pdfdadi-handoff",
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { fake, db, restore };
}

async function withStore(body: (ctx: ReturnType<typeof setup>) => Promise<void>): Promise<void> {
  const ctx = setup();
  try {
    await body(ctx);
  } finally {
    ctx.restore();
  }
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HandoffError) return error.failure;
    throw error;
  }
  throw new Error("expected a HandoffError");
}

describe("a handoff round trip", () => {
  it("returns the same bytes and the same filename", async () => {
    await withStore(async ({ db }) => {
      const id = await createHandoff(
        { fileName: "contract-merged.pdf", bytes: BYTES, provenance: PROVENANCE },
        db,
      );
      const claimed = await claimHandoff(id, Date.now(), db);
      expect(claimed.fileName).toBe("contract-merged.pdf");
      expect([...claimed.bytes]).toEqual([...BYTES]);
      expect(claimed.provenance.toolSlug).toBe("merge-pdf");
      expect(claimed.provenance.sourceFileNames).toEqual(["contract.pdf", "appendix.pdf"]);
    });
  });

  it("hands the editor a File carrying the name and the PDF type", async () => {
    await withStore(async ({ db }) => {
      const id = await createHandoff({ fileName: "scan-merged.pdf", bytes: BYTES, provenance: PROVENANCE }, db);
      const file = handoffFile(await claimHandoff(id, Date.now(), db));
      expect(file.name).toBe("scan-merged.pdf");
      expect(file.type).toBe("application/pdf");
      expect(file.size).toBe(BYTES.byteLength);
      expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...BYTES]);
    });
  });

  it("does not share the draft database", async () => {
    await withStore(async ({ db, fake }) => {
      await createHandoff({ fileName: "a.pdf", bytes: BYTES, provenance: PROVENANCE }, db);
      // Probes assert `pdfdadi-drafts` holds no records; a handoff in it would
      // also make "are there unsaved drafts?" answer yes for a file in transit.
      expect(fake.openRequests.map((r) => r.name)).not.toContain("pdfdadi-drafts");
    });
  });

  it("keys by id so two tabs cannot collide on one slot", async () => {
    await withStore(async ({ db }) => {
      const first = await createHandoff({ fileName: "a.pdf", bytes: BYTES, provenance: PROVENANCE }, db);
      const second = await createHandoff(
        { fileName: "b.pdf", bytes: new Uint8Array([1, 2, 3]), provenance: PROVENANCE },
        db,
      );
      expect(second).not.toBe(first);
      expect((await claimHandoff(first, Date.now(), db)).fileName).toBe("a.pdf");
      expect((await claimHandoff(second, Date.now(), db)).fileName).toBe("b.pdf");
    });
  });
});

describe("a handoff is consumed once", () => {
  it("is gone after the first claim, so a reload cannot reopen it", async () => {
    await withStore(async ({ db }) => {
      const id = await createHandoff({ fileName: "a.pdf", bytes: BYTES, provenance: PROVENANCE }, db);
      await claimHandoff(id, Date.now(), db);
      expect(await failure(claimHandoff(id, Date.now(), db))).toBe("missing");
    });
  });

  it("deletes an EXPIRED handoff too, rather than leaving it to be found again", async () => {
    await withStore(async ({ db }) => {
      const created = 1_000_000;
      const id = await createHandoff(
        { fileName: "a.pdf", bytes: BYTES, provenance: PROVENANCE, now: created },
        db,
      );
      expect(await failure(claimHandoff(id, created + HANDOFF_TTL_MS, db))).toBe("expired");
      expect(await db.keysWithPrefix("handoff:")).toEqual([]);
    });
  });

  it("reports a missing id rather than opening a blank editor", async () => {
    await withStore(async ({ db }) => {
      expect(await failure(claimHandoff("never-written", Date.now(), db))).toBe("missing");
    });
  });
});

describe("expiry", () => {
  it("accepts a handoff inside the window and refuses one at the boundary", () => {
    expect(isExpired({ createdAt: 0 }, HANDOFF_TTL_MS - 1)).toBe(false);
    expect(isExpired({ createdAt: 0 }, HANDOFF_TTL_MS)).toBe(true);
  });

  it("sweeps only the stale ones", async () => {
    await withStore(async ({ db }) => {
      const old = await createHandoff(
        { fileName: "old.pdf", bytes: BYTES, provenance: PROVENANCE, now: 0 },
        db,
      );
      const fresh = await createHandoff(
        { fileName: "fresh.pdf", bytes: BYTES, provenance: PROVENANCE, now: HANDOFF_TTL_MS },
        db,
      );
      expect(await sweepHandoffs(HANDOFF_TTL_MS + 1, db)).toBe(1);
      expect(await db.keysWithPrefix("handoff:")).toEqual([handoffKey(fresh)]);
      expect(await failure(claimHandoff(old, HANDOFF_TTL_MS + 1, db))).toBe("missing");
    });
  });

  it("sweeps a value it cannot parse", async () => {
    await withStore(async ({ db }) => {
      await db.putAll([{ key: handoffKey("junk"), value: { id: "junk" } }]);
      expect(await sweepHandoffs(Date.now(), db)).toBe(1);
    });
  });
});

describe("the size ceiling", () => {
  it("refuses a result too large to be worth cloning twice", async () => {
    await withStore(async ({ db }) => {
      const bytes = new Uint8Array(HANDOFF_MAX_BYTES + 1);
      expect(await failure(createHandoff({ fileName: "huge.pdf", bytes, provenance: PROVENANCE }, db))).toBe(
        "too_large",
      );
      // Refused before the database is touched: no partial write to sweep.
      expect(await db.keysWithPrefix("handoff:")).toEqual([]);
    });
  });
});

describe("parseHandoff", () => {
  const valid = {
    id: "a",
    fileName: "a.pdf",
    mimeType: "application/pdf",
    bytes: BYTES,
    createdAt: 1,
    provenance: PROVENANCE,
  };

  it("accepts a well-formed record", () => {
    expect(parseHandoff(valid)?.fileName).toBe("a.pdf");
  });

  it("rejects anything that is not a handoff", () => {
    expect(parseHandoff(null)).toBeNull();
    expect(parseHandoff("handoff")).toBeNull();
    expect(parseHandoff({ ...valid, id: 7 })).toBeNull();
    expect(parseHandoff({ ...valid, createdAt: "yesterday" })).toBeNull();
    // A non-PDF was never openable in the editor, so it is not a handoff.
    expect(parseHandoff({ ...valid, mimeType: "image/png" })).toBeNull();
  });

  it("rejects empty or non-binary bytes rather than opening an empty document", () => {
    expect(parseHandoff({ ...valid, bytes: new Uint8Array(0) })).toBeNull();
    expect(parseHandoff({ ...valid, bytes: [37, 80] })).toBeNull();
    expect(parseHandoff({ ...valid, bytes: "%PDF" })).toBeNull();
  });

  it("survives missing provenance — it is context, not a precondition for opening", () => {
    const parsed = parseHandoff({ ...valid, provenance: undefined });
    expect(parsed).not.toBeNull();
    expect(parsed?.provenance).toEqual({
      toolSlug: null,
      sourceFileNames: [],
      workspaceId: null,
      sourceDocumentId: null,
    });
  });

  it("drops non-string source names instead of rendering them", () => {
    const parsed = parseHandoff({
      ...valid,
      provenance: { toolSlug: 5, sourceFileNames: ["a.pdf", 7, null] },
    });
    expect(parsed?.provenance.toolSlug).toBeNull();
    expect(parsed?.provenance.sourceFileNames).toEqual(["a.pdf"]);
  });
});
