import { describe, expect, it } from "vitest";
import { preparationFromIngestion, resolveDocumentContent } from "./documentContent";
import type { DocumentVersion } from "@/src/domain/entities/DocumentVersion";

function version(overrides: Partial<DocumentVersion> = {}): DocumentVersion {
  return {
    id: "v1",
    workspaceId: "ws-1",
    organizationId: "org-1",
    documentId: "doc-1",
    versionNumber: 1,
    revision: 1,
    origin: "import",
    restoredFromVersionId: null,
    label: null,
    manifest: {
      schema: 1,
      sourceKey: "ca/aa/bb/deadbeef",
      sourceChecksum: "deadbeef",
      sourceByteSize: 1086,
      editorStateKey: null,
      editorStateChecksum: null,
      outputKey: null,
      outputChecksum: null,
      pageCount: 2,
      thumbnailKeys: [],
    },
    manifestDegraded: false,
    checksum: "abc",
    createdById: "user-1",
    createdAt: new Date("2026-08-05T00:00:00.000Z"),
    ...overrides,
  };
}

describe("preparationFromIngestion", () => {
  it("treats pending and processing as waitable", () => {
    expect(preparationFromIngestion("pending")).toBe("processing");
    expect(preparationFromIngestion("processing")).toBe("processing");
  });

  it("treats a failed ingestion as terminal", () => {
    expect(preparationFromIngestion("failed")).toBe("failed");
  });

  it("does not claim a complete ingestion is still preparing", () => {
    // Reporting "processing" here is exactly the endless spinner: nothing is
    // working on the document, so waiting would never resolve.
    expect(preparationFromIngestion("complete")).toBe("none");
  });

  it("does not claim preparation for a document with no ingestion at all", () => {
    expect(preparationFromIngestion(null)).toBe("none");
  });
});

describe("resolveDocumentContent", () => {
  it("serves a document that has a durable version", () => {
    const resolved = resolveDocumentContent({ documentId: "doc-1", version: version() });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.versionNumber).toBe(1);
    expect(resolved.byteSize).toBe(1086);
  });

  it("reports a document with no version as a bounded conflict", () => {
    const resolved = resolveDocumentContent({ documentId: "doc-1", version: null });
    expect(resolved).toMatchObject({ ok: false, reason: "no-version", status: 409 });
  });

  it("refuses a version belonging to another document", () => {
    const resolved = resolveDocumentContent({
      documentId: "doc-1",
      version: version({ documentId: "doc-other" }),
    });
    // Reported as not-found for this document: true, and non-disclosing.
    expect(resolved).toMatchObject({ ok: false, reason: "version-mismatch", status: 404 });
  });

  it("refuses to serve from a manifest that could not be read reliably", () => {
    const resolved = resolveDocumentContent({
      documentId: "doc-1",
      version: version({ manifestDegraded: true }),
    });
    expect(resolved).toMatchObject({ ok: false, reason: "manifest-degraded" });
  });

  it("refuses a version whose manifest names no source artifact", () => {
    const resolved = resolveDocumentContent({
      documentId: "doc-1",
      version: version({ manifest: { ...version().manifest, sourceKey: "  " } }),
    });
    expect(resolved).toMatchObject({ ok: false, reason: "no-source-artifact" });
  });

  it("never puts a storage key in a failure message", () => {
    for (const v of [null, version({ documentId: "other" }), version({ manifestDegraded: true })]) {
      const resolved = resolveDocumentContent({ documentId: "doc-1", version: v });
      if (resolved.ok) continue;
      expect(resolved.message).not.toMatch(/ca\/|deadbeef/);
    }
  });
});
