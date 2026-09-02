import { describe, expect, it } from "vitest";
import {
  CONTENT_REQUEST_LIMITS,
  contentDisposition,
  contentHeaders,
  parseContentRequest,
  resolveDocumentContent,
} from "./documentContent";
import type { DocumentVersion } from "@/src/domain/entities/DocumentVersion";

function version(overrides: Partial<DocumentVersion> = {}): DocumentVersion {
  return {
    id: "ver_1",
    workspaceId: "ws_1",
    organizationId: "org_1",
    documentId: "doc_1",
    versionNumber: 3,
    revision: 7,
    origin: "save",
    restoredFromVersionId: null,
    label: null,
    manifestDegraded: false,
    checksum: "manifest-checksum",
    createdById: "user_1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    manifest: {
      schema: 1,
      sourceKey: "org_1/ws_1/doc_1/source.pdf",
      sourceChecksum: "abc123",
      sourceByteSize: 4096,
      editorStateKey: null,
      editorStateChecksum: null,
      outputKey: null,
      outputChecksum: null,
      pageCount: 5,
      thumbnailKeys: [],
    },
    ...overrides,
  };
}

describe("resolveDocumentContent", () => {
  it("resolves the source key from the version manifest", () => {
    const result = resolveDocumentContent({ documentId: "doc_1", version: version() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sourceKey).toBe("org_1/ws_1/doc_1/source.pdf");
    expect(result.byteSize).toBe(4096);
    expect(result.versionNumber).toBe(3);
  });

  it("refuses a version belonging to another document", () => {
    const result = resolveDocumentContent({
      documentId: "doc_1",
      version: version({ documentId: "doc_2" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("version-mismatch");
    expect(result.status).toBe(404);
  });

  it("reports an honest error when the document has no version", () => {
    const result = resolveDocumentContent({ documentId: "doc_1", version: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-version");
    expect(result.status).toBe(409);
  });

  it("refuses to serve from a degraded manifest", () => {
    const result = resolveDocumentContent({
      documentId: "doc_1",
      version: version({ manifestDegraded: true }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("manifest-degraded");
  });

  it("reports a missing source artifact rather than serving nothing", () => {
    const result = resolveDocumentContent({
      documentId: "doc_1",
      version: version({ manifest: { ...version().manifest, sourceKey: "  " } }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-source-artifact");
  });

  it("treats a zero-byte source as unavailable rather than as an empty PDF", () => {
    const result = resolveDocumentContent({
      documentId: "doc_1",
      version: version({ manifest: { ...version().manifest, sourceByteSize: 0 } }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-source-artifact");
  });

  it("never surfaces a storage key in an unavailable message", () => {
    const result = resolveDocumentContent({
      documentId: "doc_1",
      version: version({ documentId: "doc_2" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain("/");
    expect(result.message).not.toContain("source.pdf");
  });
});

describe("parseContentRequest", () => {
  function params(init: Record<string, string>): URLSearchParams {
    return new URLSearchParams(init);
  }

  it("requires an organizationId", () => {
    expect(parseContentRequest(params({})).ok).toBe(false);
  });

  it("rejects an over-long organizationId", () => {
    const long = "a".repeat(CONTENT_REQUEST_LIMITS.maxIdLength + 1);
    expect(parseContentRequest(params({ organizationId: long })).ok).toBe(false);
  });

  it("defaults to the current version and inline disposition", () => {
    const result = parseContentRequest(params({ organizationId: "org_1" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.versionNumber).toBeNull();
    expect(result.disposition).toBe("inline");
  });

  it("accepts a bounded version number", () => {
    const result = parseContentRequest(params({ organizationId: "org_1", version: "12" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.versionNumber).toBe(12);
  });

  it("rejects a non-numeric version rather than falling back to the latest", () => {
    expect(parseContentRequest(params({ organizationId: "org_1", version: "latest" })).ok).toBe(false);
    expect(parseContentRequest(params({ organizationId: "org_1", version: "-3" })).ok).toBe(false);
    expect(parseContentRequest(params({ organizationId: "org_1", version: "1.5" })).ok).toBe(false);
  });

  it("rejects a version of zero", () => {
    expect(parseContentRequest(params({ organizationId: "org_1", version: "0" })).ok).toBe(false);
  });

  it("treats download=1 as an attachment request", () => {
    const result = parseContentRequest(params({ organizationId: "org_1", download: "1" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.disposition).toBe("attachment");
  });
});

describe("contentDisposition", () => {
  it("is a bare inline for the embed case", () => {
    expect(contentDisposition("inline", "anything.pdf")).toBe("inline");
  });

  it("adds a .pdf extension when the name lacks one", () => {
    expect(contentDisposition("attachment", "report")).toContain('filename="report.pdf"');
  });

  it("does not double the extension", () => {
    const value = contentDisposition("attachment", "report.pdf");
    expect(value).toContain('filename="report.pdf"');
    expect(value).not.toContain(".pdf.pdf");
  });

  it("strips quotes and header-injection characters from the ascii fallback", () => {
    const value = contentDisposition("attachment", 'evil".pdf\r\nX-Injected: 1');
    const ascii = /filename="([^"]*)"/.exec(value)?.[1] ?? "";
    expect(ascii).not.toContain('"');
    expect(ascii).not.toContain("\r");
    expect(ascii).not.toContain("\n");
    expect(value).not.toContain("X-Injected: 1\r\n");
  });

  it("carries the real name in the RFC 5987 parameter", () => {
    const value = contentDisposition("attachment", "réçu.pdf");
    expect(value).toContain("filename*=UTF-8''");
    expect(value).toContain(encodeURIComponent("réçu.pdf"));
  });

  it("bounds an absurdly long name", () => {
    const value = contentDisposition("attachment", `${"a".repeat(5000)}.pdf`);
    const ascii = /filename="([^"]*)"/.exec(value)?.[1] ?? "";
    expect(ascii.length).toBeLessThanOrEqual(150);
  });
});

describe("contentHeaders", () => {
  const headers = contentHeaders({
    byteSize: 4096,
    disposition: "inline",
    versionNumber: 3,
  });

  it("declares a PDF and forbids sniffing", () => {
    expect(headers["Content-Type"]).toBe("application/pdf");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("uses private no-store caching for tenant bytes", () => {
    expect(headers["Cache-Control"]).toContain("private");
    expect(headers["Cache-Control"]).toContain("no-store");
  });

  it("exposes the version number", () => {
    expect(headers["X-Document-Version"]).toBe("3");
  });

  it("does not echo the source checksum, which is the content-addressed key", () => {
    // Uploaded objects are stored at `ca/<aa>/<bb>/<sha256>`, so returning the
    // source checksum would disclose the object's storage location.
    const serialized = JSON.stringify(headers);
    expect(serialized).not.toContain("abc123");
    expect(Object.keys(headers)).not.toContain("X-Content-Checksum");
  });

  it("carries no storage location in any header value", () => {
    expect(Object.values(headers).join(" ")).not.toContain("source.pdf");
    expect(Object.values(headers).join(" ")).not.toMatch(/\bca\//);
  });
});
