import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

/**
 * T11 (server half) — saving the same editing session twice must update ONE
 * document.
 *
 * The editor's only byte-accepting endpoint was `documents/upload`, which always
 * creates a `DocumentRecord`, so pressing "Save to Workspace" twice produced two
 * `Untitled PDF.pdf` documents: the same logical document, saved twice, recorded
 * as two. This route is the missing update path, and these are the four things
 * about it that a refactor must not quietly undo.
 *
 * ORDER IS A SECURITY PROPERTY HERE. `validateDestination` performs the write
 * authorization, and it has to run BEFORE a byte is stored — otherwise the route
 * is a storage-write oracle for anyone who can authenticate, and the version
 * create at the end refuses the request only after the object is in the bucket.
 * `callOrder` below exists solely to pin that sequence.
 */

const state = vi.hoisted(() => ({
  callOrder: [] as string[],
  destinationOk: true,
  destinationThrows: null as Error | null,
  uploadedBytes: null as Buffer | null,
  createArgs: null as { workspaceId: string; input: Record<string, unknown> } | null,
  createThrows: null as Error | null,
  actor: { userId: "user-1", organizationId: "org-1" } as { userId: string; organizationId: string },
}));

vi.mock("@/src/application/di/container", () => ({
  appContainer: {
    resolve: () => ({
      validateDestination: async () => {
        state.callOrder.push("validateDestination");
        if (state.destinationThrows) throw state.destinationThrows;
        return state.destinationOk;
      },
      upload: async ({ data }: { data: Buffer }) => {
        state.callOrder.push("upload");
        state.uploadedBytes = data;
        return { file: { key: "stored/key.pdf" } };
      },
    }),
  },
}));

vi.mock("@/src/application/di/tokens", () => ({ Tokens: { WorkspaceAwareUploadService: "uploads" } }));

vi.mock("@/src/application/services/workspaceHttp", () => ({
  requireSameOrigin: () => null,
  // The shared upload gate authenticates BEFORE the body is read, so a harness
  // that stubs only `getWorkspaceActor` stubs half the authentication and every
  // test here 401s. Both, or neither.
  getSessionUser: async () => ({ user: { id: state.actor.userId } }),
  getWorkspaceActor: async () => ({ actor: state.actor }),
  workspaceError: (_req: unknown, code: string, message: string, status: number) =>
    NextResponse.json({ error: { code, message } }, { status }),
  mapWorkspaceError: (_req: unknown, error: unknown) =>
    NextResponse.json({ error: { code: "MAPPED", message: String(error) } }, { status: 409 }),
  workspaceServices: () => ({ audit: { record: async () => {} } }),
}));

vi.mock("@/src/application/services/versionHttp", () => ({
  versionService: () => ({
    createVersion: async (
      _actor: unknown,
      workspaceId: string,
      input: Record<string, unknown>,
    ) => {
      state.callOrder.push("createVersion");
      if (state.createThrows) throw state.createThrows;
      state.createArgs = { workspaceId, input };
      return { id: "version-1", documentRevision: 4 };
    },
  }),
  toVersionResponse: (version: { id: string }) => ({ id: version.id }),
}));

import { POST } from "@/app/api/workspaces/[workspaceId]/documents/[documentId]/versions/upload/route";

const WORKSPACE = "ws-1";
const DOCUMENT = "doc-1";
const params = Promise.resolve({ workspaceId: WORKSPACE, documentId: DOCUMENT });

/** A minimal but genuine PDF byte string: the signature is checked in the route. */
const PDF = Buffer.from("%PDF-1.7\n%%EOF\n", "ascii");

function post(body: FormData | string, headers: Record<string, string> = {}) {
  const init: RequestInit & { headers: Record<string, string> } = {
    method: "POST",
    body: body as BodyInit,
    headers: { ...headers },
  };
  if (typeof body === "string") init.headers["content-type"] = "text/plain";
  return new Request(
    `http://localhost:3001/api/workspaces/${WORKSPACE}/documents/${DOCUMENT}/versions/upload`,
    init,
  );
}

function form(opts: { bytes?: Buffer; revision?: string | null; name?: string } = {}) {
  const fd = new FormData();
  const bytes = opts.bytes ?? PDF;
  fd.set("file", new File([new Uint8Array(bytes)], opts.name ?? "document.pdf", { type: "application/pdf" }));
  if (opts.revision !== null) fd.set("expectedRevision", opts.revision ?? "3");
  return fd;
}

beforeEach(() => {
  state.callOrder = [];
  state.destinationOk = true;
  state.destinationThrows = null;
  state.uploadedBytes = null;
  state.createArgs = null;
  state.createThrows = null;
});

describe("POST …/documents/:documentId/versions/upload", () => {
  it("stores the bytes as a new version OF THE NAMED DOCUMENT", async () => {
    const res = await POST(post(form()) as never, { params });
    expect(res.status).toBe(201);
    // The produced document revision travels with the version: it is the caller's
    // next compare-and-swap token, and `version.versionNumber` is NOT it.
    expect(await res.json()).toEqual({
      version: { id: "version-1" },
      document: { revision: 4 },
    });

    // The document is addressed, never created: no `documents/upload` call, and
    // the id from the URL is what the version is attached to.
    expect(state.createArgs?.workspaceId).toBe(WORKSPACE);
    expect(state.createArgs?.input.documentId).toBe(DOCUMENT);
    expect(state.createArgs?.input.origin).toBe("save");
  });

  it("authorizes the destination before a single byte is stored", async () => {
    await POST(post(form()) as never, { params });
    expect(state.callOrder).toEqual(["validateDestination", "upload", "createVersion"]);
  });

  it("stores nothing when the destination is refused", async () => {
    state.destinationOk = false;
    const res = await POST(post(form()) as never, { params });
    expect(res.status).toBe(422);
    expect(state.callOrder).toEqual(["validateDestination"]);
    expect(state.uploadedBytes).toBeNull();
  });

  it("passes the CLIENT's expectedRevision through to the compare-and-swap", async () => {
    await POST(post(form({ revision: "12" })) as never, { params });
    expect(state.createArgs?.input.expectedRevision).toBe(12);
  });

  it("refuses a request with no expectedRevision rather than guessing one", async () => {
    // A route that read the current revision itself would satisfy the CAS by
    // construction and protect nobody.
    const res = await POST(post(form({ revision: null })) as never, { params });
    expect(res.status).toBe(422);
    expect(state.callOrder).toEqual([]);
  });

  it("refuses a non-integer expectedRevision", async () => {
    const res = await POST(post(form({ revision: "3.5" })) as never, { params });
    expect(res.status).toBe(422);
  });

  it("refuses bytes that are not a PDF, before creating a version", async () => {
    const res = await POST(post(form({ bytes: Buffer.from("<html>gotcha</html>") })) as never, {
      params,
    });
    expect(res.status).toBe(422);
    // Authorization ran; storage did not. A version whose artifact is not a PDF is
    // a document that cannot be reopened.
    expect(state.callOrder).toEqual(["validateDestination"]);
  });

  it("refuses an empty file", async () => {
    const fd = new FormData();
    fd.set("file", new File([], "document.pdf", { type: "application/pdf" }));
    fd.set("expectedRevision", "1");
    const res = await POST(post(fd) as never, { params });
    expect(res.status).toBe(422);
  });

  it("refuses a non-multipart body", async () => {
    const res = await POST(post("just some text") as never, { params });
    expect(res.status).toBe(415);
  });

  it("rejects an oversized upload on the declared length alone", async () => {
    const { DOCUMENT_INGESTION_LIMITS } = await import("@/src/domain/entities/DocumentIngestion");
    const res = await POST(
      post(form(), {
        "content-length": String(DOCUMENT_INGESTION_LIMITS.maxUploadBytes + 1),
      }) as never,
      { params },
    );
    expect(res.status).toBe(413);
    expect(state.callOrder).toEqual([]);
  });

  it("computes the manifest checksum over the bytes it actually stored", async () => {
    const crypto = await import("node:crypto");
    await POST(post(form()) as never, { params });
    const manifest = state.createArgs?.input.manifest as Record<string, unknown>;
    expect(manifest.sourceKey).toBe("stored/key.pdf");
    expect(manifest.sourceByteSize).toBe(PDF.byteLength);
    expect(manifest.sourceChecksum).toBe(crypto.createHash("sha256").update(PDF).digest("hex"));
  });

  it("surfaces a rejected compare-and-swap rather than reporting success", async () => {
    state.createThrows = new Error("revision mismatch");
    const res = await POST(post(form()) as never, { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("MAPPED");
  });
});
