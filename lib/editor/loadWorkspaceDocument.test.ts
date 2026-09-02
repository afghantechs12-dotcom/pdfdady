import { describe, expect, it, vi, afterEach } from "vitest";
import {
  WorkspaceDocumentLoadError,
  describeContentFailure,
  documentContentUrl,
  isAbortError,
} from "./loadWorkspaceDocument";
import {
  CONTENT_UNAVAILABLE_CODE,
  classifyLoadError,
  loadErrorFacts,
  presentLoadError,
} from "@/components/editor/documentLoadState";

/**
 * How a failed content response becomes evidence the UI can classify.
 *
 * These stop short of calling `loadWorkspaceDocument` itself: that function calls
 * `loadPdfIntoEditor`, which needs PDF.js, a DOM and a canvas — none of which
 * exist in this Node environment. The pieces that CAN be tested honestly here are
 * `describeContentFailure` (pure over a Response) and the classification the
 * error's shape produces. The end-to-end fetch behaviour, including a real
 * offline failure, is verified in a browser by
 * `scripts/editor-load-states-probe.mjs`.
 */

/** A JSON error response shaped like the workspace routes' own envelope. */
const errorResponse = (
  status: number,
  body: Record<string, unknown> | null = null,
): Response =>
  new Response(body === null ? "not json at all" : JSON.stringify({ error: body }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("documentContentUrl", () => {
  it("addresses a document and never a storage key", () => {
    const url = documentContentUrl({
      documentId: "doc_1",
      workspaceId: "ws_1",
      organizationId: "org_1",
      name: "Report.pdf",
    });
    expect(url).toContain("/api/workspaces/ws_1/documents/doc_1/content");
    expect(url).toContain("organizationId=org_1");
    // The client never names bytes; the server resolves them from the manifest.
    expect(url).not.toMatch(/key|bucket|s3|storage|\.pdf$/i);
  });

  it("passes a specific version through when one was requested", () => {
    const url = documentContentUrl({
      documentId: "doc_1",
      workspaceId: "ws_1",
      organizationId: "org_1",
      name: "Report.pdf",
      versionNumber: 3,
    });
    expect(url).toContain("version=3");
  });
});

describe("describeContentFailure", () => {
  it("keeps 401 and 403 distinct all the way to the classification", async () => {
    const expired = await describeContentFailure(
      errorResponse(401, { code: "UNAUTHORIZED", message: "Authentication is required." }),
    );
    const denied = await describeContentFailure(
      errorResponse(403, { code: "FORBIDDEN", message: "Organization access is not permitted." }),
    );

    expect(expired.status).toBe(401);
    expect(denied.status).toBe(403);
    expect(classifyLoadError(loadErrorFacts(expired))).toBe("auth");
    expect(classifyLoadError(loadErrorFacts(denied))).toBe("forbidden");
  });

  it("carries the server's CODE so a conflict's meaning is evidence, not a guess", async () => {
    const unavailable = await describeContentFailure(
      errorResponse(409, {
        code: CONTENT_UNAVAILABLE_CODE,
        message: "This document has no saved version yet, so there is nothing to open.",
        preparation: "processing",
      }),
    );
    expect(unavailable.code).toBe(CONTENT_UNAVAILABLE_CODE);
    expect(unavailable.preparation).toBe("processing");
    expect(classifyLoadError(loadErrorFacts(unavailable))).toBe("content-unavailable");
  });

  it("does not turn an unrelated 409 into a preparation story", async () => {
    // mapWorkspaceError answers 409/WORKSPACE_OPERATION_REJECTED for any rejected
    // domain operation — nothing to do with content preparation.
    const rejected = await describeContentFailure(
      errorResponse(409, {
        code: "WORKSPACE_OPERATION_REJECTED",
        message: "Workspace operation failed.",
      }),
    );
    expect(rejected.preparation).toBe("none");
    expect(classifyLoadError(loadErrorFacts(rejected))).toBe("unknown");
    expect(
      presentLoadError(loadErrorFacts(rejected), { context: "workspace" }).description,
    ).not.toMatch(/prepar/i);
  });

  it("marks a failed preparation terminal rather than recoverable", async () => {
    const failed = await describeContentFailure(
      errorResponse(409, {
        code: CONTENT_UNAVAILABLE_CODE,
        message: "The saved version of this document has no stored file.",
        preparation: "failed",
        detail: "The stored bytes do not match the uploaded checksum.",
      }),
    );
    // A failed ingestion will not fix itself; polling it is the endless spinner.
    expect(failed.recoverable).toBe(false);
    expect(failed.preparation).toBe("failed");
  });

  it("keeps the server's diagnostic OUT of user-facing copy", async () => {
    const detail = "The stored bytes do not match the uploaded checksum.";
    const failed = await describeContentFailure(
      errorResponse(409, {
        code: CONTENT_UNAVAILABLE_CODE,
        message: "The saved version could not be read reliably.",
        preparation: "failed",
        detail,
      }),
    );
    // Captured for the console...
    expect(failed.detail).toBe(detail);
    // ...and absent from what the user reads.
    const shown = presentLoadError(loadErrorFacts(failed), { context: "workspace" });
    expect(`${shown.heading} ${shown.description}`).not.toContain(detail);
    expect(`${shown.heading} ${shown.description}`).not.toMatch(/checksum|stored bytes/i);
    // The facts carry no detail channel at all.
    expect(Object.keys(loadErrorFacts(failed))).not.toContain("detail");
  });

  it("survives a non-JSON error body without surfacing it", async () => {
    const broken = await describeContentFailure(errorResponse(500, null));
    expect(broken.status).toBe(500);
    expect(broken.detail).toBeNull();
    expect(classifyLoadError(loadErrorFacts(broken))).toBe("unknown");
  });

  it("ignores an implausibly long server message", async () => {
    const flood = await describeContentFailure(
      errorResponse(500, { code: "INTERNAL_ERROR", message: "x".repeat(5_000) }),
    );
    // Bounded at capture time, and unused for display regardless.
    expect(flood.message.length).toBeLessThan(500);
  });

  it("reports no preparation state when the server sent none", async () => {
    const missing = await describeContentFailure(
      errorResponse(404, { code: "NOT_FOUND", message: "Document not found." }),
    );
    expect(missing.preparation).toBe("none");
    expect(classifyLoadError(loadErrorFacts(missing))).toBe("not-found");
  });
});

describe("network vs abort", () => {
  it("recognises an AbortError as cancellation", () => {
    const aborted = new Error("The operation was aborted.");
    aborted.name = "AbortError";
    expect(isAbortError(aborted)).toBe(true);
  });

  it("does not mistake a connection failure for an abort", () => {
    // What fetch throws when it cannot reach the server.
    expect(isAbortError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isAbortError(new Error("network error"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });

  it("classifies a network-flagged load error as network, never unknown", () => {
    const offline = new WorkspaceDocumentLoadError(
      "Failed to fetch",
      false,
      "none",
      null,
      null,
      null,
      true,
    );
    expect(offline.network).toBe(true);
    expect(offline.status).toBeNull();
    expect(classifyLoadError(loadErrorFacts(offline))).toBe("network");
    const shown = presentLoadError(loadErrorFacts(offline), { context: "workspace" });
    expect(shown.heading).toMatch(/connection problem/i);
    expect(shown.actions.some((a) => a.kind === "retry")).toBe(true);
    // And the raw thrown text is not what the user reads.
    expect(`${shown.heading} ${shown.description}`).not.toContain("Failed to fetch");
  });

  it("classifies a refused PDF as invalid-pdf, keeping its actionable guidance available", () => {
    const guidance =
      "This PDF has 500 pages. The editor supports up to 200 pages — please split the PDF first.";
    const invalid = new WorkspaceDocumentLoadError(
      guidance,
      false,
      "none",
      guidance,
      null,
      null,
      false,
      true,
    );
    expect(invalid.invalidPdf).toBe(true);
    expect(classifyLoadError(loadErrorFacts(invalid))).toBe("invalid-pdf");
    // The PdfOpenError text is retained on the error for logging/inspection...
    expect(invalid.detail).toBe(guidance);
    // ...while the panel shows the bounded authored copy.
    const shown = presentLoadError(loadErrorFacts(invalid), { context: "standalone" });
    expect(shown.description).toMatch(/damaged|unsupported|limits/i);
  });

  it("does not flag an HTTP failure as a network failure", () => {
    // A 500 is a server verdict; the connection worked.
    const serverFault = new WorkspaceDocumentLoadError(
      "Workspace operation failed.",
      false,
      "none",
      null,
      500,
      "INTERNAL_ERROR",
    );
    expect(serverFault.network).toBe(false);
    expect(classifyLoadError(loadErrorFacts(serverFault))).toBe("unknown");
  });
});
