import { describe, expect, it } from "vitest";
import type { DraftIndexRecord } from "./draftEnvelope";
import {
  GUEST_DOCUMENT_MAP_KEY,
  GUEST_DRAFT_MAX_AGE_MS,
  MAX_REMEMBERED_GUEST_DOCUMENTS,
  chooseRecoverableGuestDraft,
  describeGuestDocument,
  describeRecoveredDraft,
  describeWorkspaceDocument,
  fingerprintGuestFile,
  localIdentityStorage,
  replaceGuestDocument,
  resolveGuestDocument,
  sessionIdentityStorage,
} from "./documentIdentity";
import type { IdentityStorage } from "./tabCoordination";

/**
 * A tab's session storage, with the failures a real one has.
 *
 * `map` is exposed so a test can simulate a refresh (same storage, fresh resolve)
 * separately from a new tab (fresh storage) — the distinction the whole
 * fingerprint path exists to serve.
 */
class FakeStorage implements IdentityStorage {
  readonly map = new Map<string, string>();
  failRead = false;
  failWrite = false;

  read(key: string): string | null {
    if (this.failRead) throw new Error("read blocked");
    return this.map.get(key) ?? null;
  }

  write(key: string, value: string): void {
    if (this.failWrite) throw new Error("quota exceeded");
    this.map.set(key, value);
  }
}

function counter(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
}

/** Deterministic bytes whose head and tail differ from any other seed. */
function bytes(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed * 7) % 251;
  return out;
}

function draft(overrides: Partial<DraftIndexRecord> = {}): DraftIndexRecord {
  return {
    documentKey: "guest:a",
    draftId: "guest:a",
    documentId: null,
    workspaceId: null,
    documentName: "a.pdf",
    origin: "guest",
    revision: 4,
    updatedAt: 1_000,
    schemaVersion: 1,
    ...overrides,
  };
}

describe("workspace identity", () => {
  it("derives the same key from the same ids", () => {
    const first = describeWorkspaceDocument({ workspaceId: "w1", documentId: "d1" });
    const second = describeWorkspaceDocument({ workspaceId: "w1", documentId: "d1" });
    expect(second.documentKey).toBe(first.documentKey);
    expect(first).toEqual({
      documentKey: "ws:w1:d1",
      documentId: "d1",
      workspaceId: "w1",
      organizationId: null,
      origin: "workspace",
    });
  });

  it("distinguishes documents and workspaces", () => {
    const a = describeWorkspaceDocument({ workspaceId: "w1", documentId: "d1" });
    const b = describeWorkspaceDocument({ workspaceId: "w1", documentId: "d2" });
    const c = describeWorkspaceDocument({ workspaceId: "w2", documentId: "d1" });
    expect(new Set([a.documentKey, b.documentKey, c.documentKey]).size).toBe(3);
  });

  it("keeps the key independent of the organization", () => {
    /*
     * A document can be moved between organizations. If the org were part of the
     * key, the move would orphan every draft written before it.
     */
    const withOrg = describeWorkspaceDocument({
      workspaceId: "w1",
      documentId: "d1",
      organizationId: "org-1",
    });
    const without = describeWorkspaceDocument({ workspaceId: "w1", documentId: "d1" });
    expect(withOrg.documentKey).toBe(without.documentKey);
    expect(withOrg.organizationId).toBe("org-1");
  });

  it("refuses a blank id rather than making every document share a key", () => {
    expect(() => describeWorkspaceDocument({ workspaceId: " ", documentId: "d1" })).toThrow();
    expect(() => describeWorkspaceDocument({ workspaceId: "w1", documentId: "" })).toThrow();
  });

  it("never collides with a guest key", () => {
    const workspace = describeWorkspaceDocument({ workspaceId: "w1", documentId: "d1" });
    const guest = describeGuestDocument("w1:d1");
    expect(workspace.documentKey).not.toBe(guest.documentKey);
  });
});

describe("guest fingerprints", () => {
  it("is stable for the same file", () => {
    const file = { fileName: "report.pdf", bytes: bytes(1, 10_000) };
    expect(fingerprintGuestFile(file)).toBe(fingerprintGuestFile({ ...file }));
  });

  it("separates two files of the same name and length", () => {
    // Same name, same byte count, different content. Only the content sample can
    // tell these apart, so this is the test that proves the sample is read.
    const a = fingerprintGuestFile({ fileName: "report.pdf", bytes: bytes(1, 10_000) });
    const b = fingerprintGuestFile({ fileName: "report.pdf", bytes: bytes(2, 10_000) });
    expect(a).not.toBe(b);
  });

  it("separates the same content under two names", () => {
    const content = bytes(3, 5_000);
    const a = fingerprintGuestFile({ fileName: "invoice.pdf", bytes: content });
    const b = fingerprintGuestFile({ fileName: "invoice-final.pdf", bytes: content });
    expect(a).not.toBe(b);
  });

  it("notices a truncated file even when both ends survive", () => {
    const full = bytes(4, 20_000);
    const truncated = full.subarray(0, 19_000);
    expect(fingerprintGuestFile({ fileName: "x.pdf", bytes: full })).not.toBe(
      fingerprintGuestFile({ fileName: "x.pdf", bytes: truncated }),
    );
  });

  it("notices a change in the middle of a large file", () => {
    /*
     * The sample reads only the ends, so a middle edit is invisible to it. The
     * length is what carries the difference here; when an edit preserves the
     * length too, two drafts share a key and the offer names the file. Documented
     * as the known limit of a synchronous fingerprint.
     */
    const original = bytes(5, 100_000);
    const grown = new Uint8Array(original.length + 1);
    grown.set(original);
    expect(fingerprintGuestFile({ fileName: "big.pdf", bytes: original })).not.toBe(
      fingerprintGuestFile({ fileName: "big.pdf", bytes: grown }),
    );
  });

  it("still produces a fingerprint with no bytes to read", () => {
    const noBytes = fingerprintGuestFile({ fileName: "x.pdf", bytes: null, byteLength: 900 });
    expect(noBytes).toBeTruthy();
    // And it must not be mistaken for the sampled fingerprint of that same file.
    expect(noBytes).not.toBe(fingerprintGuestFile({ fileName: "x.pdf", bytes: bytes(6, 900) }));
  });

  it("matches a name composed two different ways", () => {
    /*
     * macOS hands back decomposed names and Windows composed ones. The same file
     * dragged in from two places must not become two drafts.
     */
    const content = bytes(7, 2_000);
    const composed = fingerprintGuestFile({ fileName: "caf\u00e9.pdf", bytes: content });
    const decomposed = fingerprintGuestFile({ fileName: "cafe\u0301.pdf", bytes: content });
    // Guards the test itself: these two names are different strings in the source.
    expect("cafe\u0301.pdf").not.toBe("caf\u00e9.pdf");
    expect(decomposed).toBe(composed);
  });

  it("ignores surrounding whitespace in a name", () => {
    const content = bytes(8, 2_000);
    expect(fingerprintGuestFile({ fileName: "  a.pdf ", bytes: content })).toBe(
      fingerprintGuestFile({ fileName: "a.pdf", bytes: content }),
    );
  });
});

describe("resolving a guest document", () => {
  it("mints an id the first time and reuses it after a refresh", () => {
    /*
     * THE INVARIANT THE FEATURE RESTS ON. The second resolve stands for a page
     * reload: fresh call, fresh everything except session storage, same file
     * re-picked. A different key here means the draft written before the reload is
     * never found again, while every save still reports success.
     */
    const storage = new FakeStorage();
    const fingerprint = fingerprintGuestFile({ fileName: "a.pdf", bytes: bytes(1, 3_000) });

    const first = resolveGuestDocument(storage, fingerprint, counter());
    const afterRefresh = resolveGuestDocument(storage, fingerprint, counter("other"));

    expect(first.reused).toBe(false);
    expect(afterRefresh.reused).toBe(true);
    expect(afterRefresh.documentKey).toBe(first.documentKey);
    expect(afterRefresh.guestDocumentId).toBe(first.guestDocumentId);
    expect(first.persisted).toBe(true);
  });

  it("gives a different file a different key in the same tab", () => {
    // Pairs with the test above: without this, a resolver that returned one
    // constant key would pass the reuse assertion and lose every second document.
    const storage = new FakeStorage();
    const a = resolveGuestDocument(
      storage,
      fingerprintGuestFile({ fileName: "a.pdf", bytes: bytes(1, 3_000) }),
      counter(),
    );
    const b = resolveGuestDocument(
      storage,
      fingerprintGuestFile({ fileName: "b.pdf", bytes: bytes(2, 3_000) }),
      counter("b"),
    );
    expect(b.documentKey).not.toBe(a.documentKey);
    expect(b.reused).toBe(false);
  });

  it("gives a new tab a new key for the same file", () => {
    const fingerprint = fingerprintGuestFile({ fileName: "a.pdf", bytes: bytes(1, 3_000) });
    const tabOne = resolveGuestDocument(new FakeStorage(), fingerprint, counter("t1"));
    const tabTwo = resolveGuestDocument(new FakeStorage(), fingerprint, counter("t2"));
    expect(tabTwo.documentKey).not.toBe(tabOne.documentKey);
  });

  it("keeps a re-opened file from being evicted", () => {
    const storage = new FakeStorage();
    const ids = counter();
    const first = fingerprintGuestFile({ fileName: "keep.pdf", bytes: bytes(0, 1_000) });
    const kept = resolveGuestDocument(storage, first, ids);

    // Touch it again so it becomes most-recent, then open enough files to fill the map.
    resolveGuestDocument(storage, first, ids);
    for (let i = 1; i <= MAX_REMEMBERED_GUEST_DOCUMENTS - 1; i += 1) {
      resolveGuestDocument(
        storage,
        fingerprintGuestFile({ fileName: `f${i}.pdf`, bytes: bytes(i + 10, 1_000) }),
        ids,
      );
    }

    const again = resolveGuestDocument(storage, first, ids);
    expect(again.reused).toBe(true);
    expect(again.documentKey).toBe(kept.documentKey);
  });

  it("bounds what one tab remembers", () => {
    const storage = new FakeStorage();
    const ids = counter();
    const total = MAX_REMEMBERED_GUEST_DOCUMENTS + 4;
    for (let i = 0; i < total; i += 1) {
      resolveGuestDocument(
        storage,
        fingerprintGuestFile({ fileName: `f${i}.pdf`, bytes: bytes(i + 1, 1_000) }),
        ids,
      );
    }
    const stored = JSON.parse(storage.map.get(GUEST_DOCUMENT_MAP_KEY) as string) as {
      entries: unknown[];
    };
    expect(stored.entries).toHaveLength(MAX_REMEMBERED_GUEST_DOCUMENTS);

    // The oldest file is the one that lost its mapping, not the newest.
    const oldest = fingerprintGuestFile({ fileName: "f0.pdf", bytes: bytes(1, 1_000) });
    const newest = fingerprintGuestFile({ fileName: `f${total - 1}.pdf`, bytes: bytes(total, 1_000) });
    expect(resolveGuestDocument(storage, oldest, ids).reused).toBe(false);
    expect(resolveGuestDocument(storage, newest, ids).reused).toBe(true);
  });

  it("opens the document anyway when there is no storage", () => {
    const resolved = resolveGuestDocument(null, "fp", counter());
    expect(resolved.documentKey).toContain("guest:");
    expect(resolved.persisted).toBe(false);
    expect(resolved.reused).toBe(false);
  });

  it("reports an unstorable mapping instead of hiding it", () => {
    const storage = new FakeStorage();
    storage.failWrite = true;
    const resolved = resolveGuestDocument(storage, "fp", counter());
    expect(resolved.documentKey).toBeTruthy();
    expect(resolved.persisted).toBe(false);
  });

  it("survives a storage that refuses to be read", () => {
    const storage = new FakeStorage();
    storage.failRead = true;
    const resolved = resolveGuestDocument(storage, "fp", counter());
    expect(resolved.reused).toBe(false);
    expect(resolved.documentKey).toBeTruthy();
  });

  it("starts over on a corrupt map rather than throwing", () => {
    const storage = new FakeStorage();
    storage.map.set(GUEST_DOCUMENT_MAP_KEY, "{not json");
    const resolved = resolveGuestDocument(storage, "fp", counter());
    expect(resolved.reused).toBe(false);
    expect(resolved.persisted).toBe(true);
    // And the corrupt value is replaced, so it cannot fail forever.
    expect(resolveGuestDocument(storage, "fp", counter("second")).reused).toBe(true);
  });

  it("skips malformed entries and keeps the usable ones", () => {
    const storage = new FakeStorage();
    storage.map.set(
      GUEST_DOCUMENT_MAP_KEY,
      JSON.stringify({
        v: 1,
        entries: [null, 7, { f: 1, id: "x" }, { f: "good", id: 2 }, { f: "good", id: "kept" }],
      }),
    );
    expect(resolveGuestDocument(storage, "good", counter()).guestDocumentId).toBe("kept");
    expect(resolveGuestDocument(storage, "missing", counter("new")).reused).toBe(false);
  });

  it("tolerates a map with no entries array", () => {
    const storage = new FakeStorage();
    storage.map.set(GUEST_DOCUMENT_MAP_KEY, JSON.stringify({ v: 1 }));
    expect(resolveGuestDocument(storage, "fp", counter()).reused).toBe(false);
  });

  it("rejects a blank guest id", () => {
    expect(() => describeGuestDocument("  ")).toThrow();
  });
});

describe("replacing a guest document", () => {
  /*
   * WHY THIS FUNCTION EXISTS AT ALL. It is called from exactly one place: the user
   * has just declined a recovery offer, and the editor now needs a key to save
   * their next keystrokes under. `resolveGuestDocument` would hand back the key of
   * the draft they declined, and the first autosave would advance that draft's
   * pointer to the new, near-empty page. The old bytes would still be in the store
   * but no longer the generation a restore reads, so "declining is not deleting"
   * would quietly stop being true. Every test here is about that distinction.
   *
   * MUTATION-CHECKED, since a green suite is what let the bug it fixes ship: dropping
   * the dedup filter fails 1; returning `reused: true` fails 2; and reusing the
   * existing id instead of minting — the exact bug — fails 1.
   */
  it("mints a NEW id for a fingerprint that already has one", () => {
    const storage = new FakeStorage();
    const before = resolveGuestDocument(storage, "blank:document", counter("old"));
    const after = replaceGuestDocument(storage, "blank:document", counter("new"));

    expect(after.guestDocumentId).not.toBe(before.guestDocumentId);
    expect(after.documentKey).not.toBe(before.documentKey);
    // The whole point: never reported as a continuation, so no caller can mistake
    // this for the reuse path and skip a fresh capture.
    expect(after.reused).toBe(false);
  });

  it("leaves no second entry for the same fingerprint", () => {
    /*
     * The replaced entry has to go, not merely be shadowed. A duplicate would make
     * the map's order load-bearing and could resurrect the declined key after a few
     * more documents pushed the new entry down.
     */
    const storage = new FakeStorage();
    resolveGuestDocument(storage, "fp", counter("old"));
    const replaced = replaceGuestDocument(storage, "fp", counter("new"));

    const stored = JSON.parse(storage.map.get(GUEST_DOCUMENT_MAP_KEY) as string) as {
      entries: { f: string; id: string }[];
    };
    expect(stored.entries.filter((entry) => entry.f === "fp")).toHaveLength(1);
    expect(stored.entries[0]?.id).toBe(replaced.guestDocumentId);
  });

  it("is what a later resolve of the same fingerprint now finds", () => {
    // A reload after the replacement must continue the NEW draft, not the declined
    // one — otherwise the next mount reopens the offer the user already answered.
    const storage = new FakeStorage();
    resolveGuestDocument(storage, "fp", counter("old"));
    const replaced = replaceGuestDocument(storage, "fp", counter("new"));

    const afterReload = resolveGuestDocument(storage, "fp", counter("unused"));
    expect(afterReload.reused).toBe(true);
    expect(afterReload.guestDocumentId).toBe(replaced.guestDocumentId);
  });

  it("keeps the other remembered documents, and their order", () => {
    /*
     * Declining one document's draft must not cost the user the identities of the
     * files they still have open in other tabs of the same session.
     */
    const storage = new FakeStorage();
    const ids = counter();
    resolveGuestDocument(storage, "a", ids);
    resolveGuestDocument(storage, "target", ids);
    resolveGuestDocument(storage, "b", ids);
    const survivors = (
      JSON.parse(storage.map.get(GUEST_DOCUMENT_MAP_KEY) as string) as {
        entries: { f: string; id: string }[];
      }
    ).entries.filter((entry) => entry.f !== "target");

    replaceGuestDocument(storage, "target", counter("new"));

    const after = (
      JSON.parse(storage.map.get(GUEST_DOCUMENT_MAP_KEY) as string) as {
        entries: { f: string; id: string }[];
      }
    ).entries;
    expect(after.filter((entry) => entry.f !== "target")).toEqual(survivors);
  });

  it("works as a plain mint when the fingerprint is unknown", () => {
    // Reached whenever the blank page was never resolved in this tab. It must not
    // depend on there being something to remove.
    const storage = new FakeStorage();
    const minted = replaceGuestDocument(storage, "never-seen", counter("new"));

    expect(minted.reused).toBe(false);
    expect(minted.persisted).toBe(true);
    expect(resolveGuestDocument(storage, "never-seen", counter("x")).guestDocumentId).toBe(
      minted.guestDocumentId,
    );
  });

  it("still returns a usable key when there is no storage", () => {
    /*
     * Private-mode and quota failures must not leave the editor without a key —
     * that is the state where nothing at all gets saved. An unpersisted key still
     * autosaves; it just will not be found again after a reload, which the caller
     * surfaces through `persisted`.
     */
    const minted = replaceGuestDocument(null, "fp", counter("new"));
    expect(minted.persisted).toBe(false);
    expect(minted.documentKey).toContain(minted.guestDocumentId);

    const blocked = new FakeStorage();
    blocked.failWrite = true;
    expect(replaceGuestDocument(blocked, "fp", counter("new")).persisted).toBe(false);
  });

  it("bounds the map like the resolve path does", () => {
    const storage = new FakeStorage();
    const ids = counter();
    for (let i = 0; i < MAX_REMEMBERED_GUEST_DOCUMENTS + 3; i += 1) {
      resolveGuestDocument(storage, `f${i}`, ids);
    }
    replaceGuestDocument(storage, "f0", counter("new"));
    const stored = JSON.parse(storage.map.get(GUEST_DOCUMENT_MAP_KEY) as string) as {
      entries: unknown[];
    };
    expect(stored.entries).toHaveLength(MAX_REMEMBERED_GUEST_DOCUMENTS);
  });
});

describe("choosing a draft to offer on an empty editor", () => {
  it("offers nothing when there are no drafts", () => {
    expect(chooseRecoverableGuestDraft({ drafts: [], now: 1_000 })).toBeNull();
  });

  it("offers the most recent guest draft", () => {
    const chosen = chooseRecoverableGuestDraft({
      drafts: [
        draft({ documentKey: "guest:old", updatedAt: 1_000 }),
        draft({ documentKey: "guest:new", updatedAt: 5_000 }),
        draft({ documentKey: "guest:mid", updatedAt: 3_000 }),
      ],
      now: 5_500,
    });
    expect(chosen?.documentKey).toBe("guest:new");
  });

  it("never offers a workspace draft, even a newer one", () => {
    /*
     * A workspace draft's route back to the server is the workspace URL. Restoring
     * one on the guest editor puts a document on screen whose only way to be saved
     * is a fresh upload under a new identity.
     */
    const chosen = chooseRecoverableGuestDraft({
      drafts: [
        draft({ documentKey: "guest:g", updatedAt: 1_000 }),
        draft({
          documentKey: "ws:w1:d1",
          origin: "workspace",
          workspaceId: "w1",
          documentId: "d1",
          updatedAt: 9_000,
        }),
      ],
      now: 9_500,
    });
    expect(chosen?.documentKey).toBe("guest:g");
  });

  it("skips a draft with no edits in it", () => {
    const chosen = chooseRecoverableGuestDraft({
      drafts: [
        draft({ documentKey: "guest:empty", revision: 0, updatedAt: 9_000 }),
        draft({ documentKey: "guest:edited", revision: 1, updatedAt: 1_000 }),
      ],
      now: 9_500,
    });
    expect(chosen?.documentKey).toBe("guest:edited");
  });

  it("skips the document this tab already has open", () => {
    const chosen = chooseRecoverableGuestDraft({
      drafts: [
        draft({ documentKey: "guest:open", updatedAt: 9_000 }),
        draft({ documentKey: "guest:other", updatedAt: 1_000 }),
      ],
      now: 9_500,
      excludeDocumentKeys: ["guest:open"],
    });
    expect(chosen?.documentKey).toBe("guest:other");
  });

  it("offers a draft exactly at the age limit and not one past it", () => {
    const now = GUEST_DRAFT_MAX_AGE_MS + 10_000;
    const atLimit = chooseRecoverableGuestDraft({
      drafts: [draft({ updatedAt: now - GUEST_DRAFT_MAX_AGE_MS })],
      now,
    });
    const pastLimit = chooseRecoverableGuestDraft({
      drafts: [draft({ updatedAt: now - GUEST_DRAFT_MAX_AGE_MS - 1 })],
      now,
    });
    expect(atLimit).not.toBeNull();
    expect(pastLimit).toBeNull();
  });

  it("offers a draft stamped in the future", () => {
    // A wrong clock is not a reason to withhold someone's work.
    const chosen = chooseRecoverableGuestDraft({
      drafts: [draft({ updatedAt: 10_000 })],
      now: 1_000,
    });
    expect(chosen).not.toBeNull();
  });

  it("ignores a draft with an unusable timestamp", () => {
    expect(
      chooseRecoverableGuestDraft({ drafts: [draft({ updatedAt: Number.NaN })], now: 1_000 }),
    ).toBeNull();
  });

  it("breaks a timestamp tie on the further-along draft", () => {
    const chosen = chooseRecoverableGuestDraft({
      drafts: [
        draft({ documentKey: "guest:behind", revision: 2, updatedAt: 4_000 }),
        draft({ documentKey: "guest:ahead", revision: 9, updatedAt: 4_000 }),
      ],
      now: 4_500,
    });
    expect(chosen?.documentKey).toBe("guest:ahead");
  });

  it("chooses the same draft whatever order the store lists them in", () => {
    const records = [
      draft({ documentKey: "guest:b", revision: 3, updatedAt: 4_000 }),
      draft({ documentKey: "guest:a", revision: 3, updatedAt: 4_000 }),
    ];
    const forward = chooseRecoverableGuestDraft({ drafts: records, now: 4_500 });
    const reversed = chooseRecoverableGuestDraft({ drafts: [...records].reverse(), now: 4_500 });
    expect(forward?.documentKey).toBe(reversed?.documentKey);
  });

  it("reopens a recovered draft under its own key", () => {
    /*
     * Minting a fresh key here would write the first post-restore save to a
     * different document and leave the draft it recovered from behind as a second
     * copy of the same work.
     */
    const record = draft({ documentKey: "guest:abc", draftId: "guest:abc" });
    const identity = describeRecoveredDraft(record);
    expect(identity.documentKey).toBe("guest:abc");
    expect(identity.origin).toBe("guest");
    expect(identity.workspaceId).toBeNull();
  });

  it("reopens a recovered workspace draft with its workspace ids", () => {
    const identity = describeRecoveredDraft(
      draft({
        documentKey: "ws:w1:d1",
        origin: "workspace",
        workspaceId: "w1",
        documentId: "d1",
      }),
    );
    expect(identity).toMatchObject({
      documentKey: "ws:w1:d1",
      workspaceId: "w1",
      documentId: "d1",
      origin: "workspace",
    });
  });
});

describe("storage adapters", () => {
  it("reports no storage where there is none", () => {
    expect(sessionIdentityStorage(undefined)).toBeNull();
    expect(sessionIdentityStorage({})).toBeNull();
    expect(localIdentityStorage({ localStorage: null })).toBeNull();
  });

  it("round-trips through the real storage shape", () => {
    const backing = new Map<string, string>();
    const fake = {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
    } as unknown as Storage;

    const session = sessionIdentityStorage({ sessionStorage: fake });
    session?.write("k", "v");
    expect(session?.read("k")).toBe("v");
    expect(session?.read("absent")).toBeNull();

    const local = localIdentityStorage({ localStorage: fake });
    expect(local?.read("k")).toBe("v");
  });
});
