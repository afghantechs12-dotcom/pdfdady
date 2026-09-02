import { describe, expect, it } from "vitest";
import type { SerializedEditorState } from "../ports/ISerializer";
import {
  ASSET_INLINE_THRESHOLD,
  buildDraftSnapshot,
  manifestChecksum,
  type BuildDraftInput,
  type DraftAssetBlob,
} from "./draftEnvelope";
import {
  REMOTE_ENVELOPE_ALLOWANCE,
  planRemoteSnapshot,
  remoteSnapshotBudget,
  type RemoteSnapshotPlan,
} from "./remotePayload";

/**
 * The ~1 MiB autosave ceiling, and the two wrong ways out of it.
 *
 * The first wrong way is to drop assets until the payload fits. It "works": every
 * save succeeds, the status says Saved, and the recovered document is missing the
 * signature the user placed on page 3 — discovered weeks later by whoever opens
 * it. The second wrong way is to skip the remote save when the document is too
 * big and leave the status alone, which claims a cloud backup that does not exist.
 *
 * The right way is to notice which bytes the server ALREADY HAS. A workspace
 * document's original file is stored by the workspace; re-uploading it inside
 * every autosave draft is what puts a two-page document with a photo over the
 * limit. Omitting it is not a loss, because it is recoverable from the workspace.
 * Anything the user added in the editor exists nowhere else, so it either rides
 * along or the backup is honestly reported as unavailable.
 */

function bigDataUrl(seed: string): string {
  return `data:image/png;base64,${seed.repeat(ASSET_INLINE_THRESHOLD)}`;
}

function scene(document: unknown = { id: "doc-1", name: "Report.pdf", pages: [] }): SerializedEditorState {
  return {
    format: "pdfdadi-editor",
    version: 6,
    document,
    activePageId: "page-1",
    selection: { objectIds: [] },
  };
}

function workspaceInput(overrides: Partial<BuildDraftInput> = {}): BuildDraftInput {
  return {
    draftId: "draft-1",
    documentKey: "ws:w1/doc-1",
    documentId: "doc-1",
    workspaceId: "w1",
    organizationId: "org-1",
    documentName: "Report.pdf",
    origin: "workspace",
    generation: 1,
    createdAt: 1_000,
    updatedAt: 2_000,
    revision: 7,
    lastLocallyDurableRevision: 7,
    lastRemoteAcknowledgedRevision: 5,
    serverVersion: 9,
    etag: null,
    scene: scene(),
    sourceBytes: new Uint8Array(200_000).fill(37),
    sourceReference: null,
    pageCount: 2,
    objectCount: 1,
    ...overrides,
  };
}

const LIMIT = 1024 * 1024;

function plan(
  input: BuildDraftInput,
  options: { maxBytes?: number; extraAssets?: readonly DraftAssetBlob[] } = {},
): RemoteSnapshotPlan {
  const built = buildDraftSnapshot(input);
  return planRemoteSnapshot({
    record: built.record,
    assets: [...built.assets, ...(options.extraAssets ?? [])],
    maxBytes: options.maxBytes ?? LIMIT,
  });
}

function withImage(seed = "a"): BuildDraftInput {
  return workspaceInput({
    scene: scene({
      id: "doc-1",
      name: "Report.pdf",
      pages: [{ objects: [{ id: "img-1", kind: "image", src: bigDataUrl(seed) }] }],
    }),
    objectCount: 1,
  });
}

describe("what may be left out of a remote backup", () => {
  it("omits the original file, because the workspace already stores it", () => {
    const result = plan(workspaceInput());
    expect(result.verdict).toBe("reduced");
    if (result.verdict !== "reduced") return;
    expect(result.snapshot.assets.some((asset) => asset.role === "source-pdf")).toBe(false);
    expect(result.snapshot.omitted).toHaveLength(1);
    expect(result.snapshot.omitted[0]!.role).toBe("source-pdf");
    expect(result.snapshot.omitted[0]!.reason).toBe("stored_in_workspace");
  });

  it("says where the omitted bytes can be found instead", () => {
    const result = plan(workspaceInput());
    if (result.verdict !== "reduced") throw new Error(result.verdict);
    // An omission whose replacement is unnamed is indistinguishable from a loss.
    expect(result.snapshot.omitted[0]!.availableFrom).toBe("workspace:w1/doc-1");
    expect(result.snapshot.omitted[0]!.byteLength).toBe(200_000);
  });

  it("leaves the manifest and its checksum untouched, so the remote copy validates like the local one", () => {
    const built = buildDraftSnapshot(workspaceInput());
    const result = planRemoteSnapshot({
      record: built.record,
      assets: built.assets,
      maxBytes: LIMIT,
    });
    if (result.verdict !== "reduced") throw new Error(result.verdict);
    /*
     * The tempting alternative is to rewrite `sourceReference` on the way out so
     * the remote manifest explains itself. It would also invalidate the checksum,
     * and a snapshot whose checksum does not match its manifest is exactly what
     * `parseSnapshotRecord` refuses to load — so the reduction is recorded beside
     * the record, never inside it.
     */
    expect(result.snapshot.record.checksum).toBe(built.record.checksum);
    expect(result.snapshot.record.checksum).toBe(manifestChecksum(result.snapshot.record.manifest));
    expect(result.snapshot.record.manifest.sourcePdf).not.toBeNull();
  });

  it("never omits an image the user added, because it exists nowhere else", () => {
    const result = plan(withImage());
    if (result.verdict !== "reduced") throw new Error(result.verdict);
    expect(result.snapshot.assets.map((asset) => asset.role)).toEqual(["image"]);
    expect(result.snapshot.omitted.map((asset) => asset.role)).toEqual(["source-pdf"]);
  });

  it("never omits a signature either", () => {
    const result = plan(
      workspaceInput({
        scene: scene({
          id: "doc-1",
          name: "Report.pdf",
          pages: [{ objects: [{ id: "sig-1", kind: "signature", src: bigDataUrl("s") }] }],
        }),
      }),
    );
    if (result.verdict !== "reduced") throw new Error(result.verdict);
    expect(result.snapshot.assets.map((asset) => asset.role)).toEqual(["signature"]);
  });

  it("reports a guest document as having no remote to back up to", () => {
    const result = plan(
      workspaceInput({
        origin: "guest",
        documentId: null,
        workspaceId: null,
        organizationId: null,
        documentKey: "guest:abc",
      }),
    );
    expect(result.verdict).toBe("not_applicable");
  });

  it("refuses to omit anything for a workspace draft that cannot name its document", () => {
    // Origin says workspace but the locator is missing, so "the workspace has the
    // file" cannot be asserted. Guessing would produce an omission pointing nowhere.
    const result = plan(workspaceInput({ workspaceId: null }));
    expect(result.verdict).toBe("not_applicable");
  });

  it("still produces a complete backup when there were no source bytes to omit", () => {
    const result = plan(
      workspaceInput({ sourceBytes: null, sourceReference: "workspace:w1/doc-1" }),
    );
    expect(result.verdict).toBe("complete");
    if (result.verdict !== "complete") return;
    expect(result.snapshot.omitted).toHaveLength(0);
  });
});

describe("the capacity ceiling", () => {
  it("fits a document whose bulk was the original file", () => {
    // 3 MB of source PDF, a small scene: over the limit whole, comfortably under it
    // reduced. This is the case the ceiling was actually failing on.
    const result = plan(workspaceInput({ sourceBytes: new Uint8Array(3_000_000).fill(37) }));
    expect(result.verdict).toBe("reduced");
    if (result.verdict !== "reduced") return;
    expect(result.bytes).toBeLessThan(LIMIT);
  });

  it("measures the exact string that would be sent", () => {
    const result = plan(workspaceInput());
    if (result.verdict !== "reduced") throw new Error(result.verdict);
    expect(result.bytes).toBe(new TextEncoder().encode(result.body).byteLength);
    expect(JSON.parse(result.body)).toEqual(JSON.parse(JSON.stringify(result.snapshot)));
  });

  it("reports the backup as unavailable rather than dropping a user asset to fit", () => {
    const result = plan(withImage(), { maxBytes: 2_048 });
    expect(result.verdict).toBe("unavailable");
    if (result.verdict !== "unavailable") return;
    expect(result.cause).toBe("too_large");
    expect(result.failure.category).toBe("payload_too_large");
  });

  it("marks the capacity refusal non-retryable, because the same bytes are refused identically", () => {
    const result = plan(withImage(), { maxBytes: 2_048 });
    if (result.verdict !== "unavailable") throw new Error(result.verdict);
    expect(result.failure.retryable).toBe(false);
  });

  it("names both the size and the limit, so the message is actionable", () => {
    const result = plan(withImage(), { maxBytes: 2_048 });
    if (result.verdict !== "unavailable") throw new Error(result.verdict);
    expect(result.failure.message).toContain("2 KB");
    expect(result.failure.message).toMatch(/\d+ KB/);
    expect(result.bytes).toBeGreaterThan(result.limitBytes);
  });

  it("does not count the omitted original file against the limit", () => {
    const small = plan(workspaceInput({ sourceBytes: new Uint8Array(1_000).fill(37) }));
    const huge = plan(workspaceInput({ sourceBytes: new Uint8Array(5_000_000).fill(37) }));
    if (small.verdict !== "reduced" || huge.verdict !== "reduced") throw new Error("reduced");
    // The manifest records different byte lengths, so the payloads differ by a few
    // characters — but not by the five megabytes that were left behind.
    expect(Math.abs(huge.bytes - small.bytes)).toBeLessThan(64);
  });
});

describe("assets that cannot be sent", () => {
  it("refuses raw bytes rather than JSON-encoding them into a number map", () => {
    /*
     * `JSON.stringify(new Uint8Array([1,2]))` is `{"0":1,"1":2}`: four times the
     * size, and it deserialises to an object that is not a Uint8Array. A silent
     * pass-through here would produce a remote draft that restores an image as a
     * plain object and fails somewhere far away from this file.
     */
    const built = buildDraftSnapshot(withImage());
    const assets = built.assets.map((asset) =>
      asset.role === "image" ? { ...asset, data: new Uint8Array([1, 2, 3]) } : asset,
    );
    const result = planRemoteSnapshot({ record: built.record, assets, maxBytes: LIMIT });
    expect(result.verdict).toBe("unavailable");
    if (result.verdict !== "unavailable") return;
    expect(result.cause).toBe("unencodable");
    expect(result.failure.retryable).toBe(false);
  });

  it("reports an asset the manifest references but nobody supplied", () => {
    const built = buildDraftSnapshot(withImage());
    const result = planRemoteSnapshot({
      record: built.record,
      assets: built.assets.filter((asset) => asset.role !== "image"),
      maxBytes: LIMIT,
    });
    expect(result.verdict).toBe("unavailable");
    if (result.verdict !== "unavailable") return;
    expect(result.cause).toBe("incomplete");
    expect(result.failure.message).toMatch(/image/i);
  });

  it("does not send an asset the manifest does not reference", () => {
    const stray: DraftAssetBlob = {
      hash: "deadbeef",
      role: "image",
      byteLength: 4,
      mimeType: "image/png",
      data: "data:image/png;base64,AAAA",
    };
    const result = plan(withImage(), { extraAssets: [stray] });
    if (result.verdict !== "reduced") throw new Error(result.verdict);
    expect(result.snapshot.assets.some((asset) => asset.hash === "deadbeef")).toBe(false);
  });

  it("sends each distinct asset once even when it was supplied twice", () => {
    const built = buildDraftSnapshot(withImage());
    const duplicated = [...built.assets, ...built.assets];
    const result = planRemoteSnapshot({
      record: built.record,
      assets: duplicated,
      maxBytes: LIMIT,
    });
    if (result.verdict !== "reduced") throw new Error(result.verdict);
    expect(result.snapshot.assets).toHaveLength(1);
  });
});

describe("the envelope allowance", () => {
  it("leaves the snapshot less than the endpoint accepts, so the transport is the authority", () => {
    expect(remoteSnapshotBudget(1024 * 1024)).toBe(1024 * 1024 - REMOTE_ENVELOPE_ALLOWANCE);
    expect(remoteSnapshotBudget(1024 * 1024)).toBeLessThan(1024 * 1024);
  });

  it("never reports a negative budget for an endpoint smaller than the allowance", () => {
    // A misconfigured limit must produce "nothing fits", not a negative number that
    // every comparison then reads as "everything fits".
    expect(remoteSnapshotBudget(100)).toBe(0);
  });
});
