import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import crypto from "node:crypto";

/**
 * T13 — the WORKSPACE round trip: save a scene, reopen it, get the same document.
 *
 * The recorded regression lived here. A version used to be flattened PDF bytes
 * and nothing else, so "reopen in the editor" was a RE-IMPORT: the saved PDF was
 * parsed back into whatever pdf.js could recover, objects came back as
 * source-text runs, and a yellow sticky note came back as bare text. Phase 2's
 * tests all passed throughout, because they asked "did the version commit?" and
 * it did.
 *
 * WHAT IS REAL HERE, because a fake in the wrong place is how that stayed hidden:
 *
 *  - the REAL POST `versions/upload` and GET `editor-state` / `content` route
 *    handlers, imported and called with real `Request` objects;
 *  - the REAL {@link VersionService}, so the manifest is written and read the way
 *    production writes and reads it, including the compare-and-swap;
 *  - the REAL {@link InMemoryDocumentVersionRepository}, which stores manifests
 *    SERIALIZED and re-reads them through `readManifest` — the same bounded parse
 *    and the same degradation the Prisma adapter performs. A repository that held
 *    the manifest object in memory would prove nothing about a 16 KiB bound;
 *  - the REAL {@link SerializationService} on both sides, and a REAL
 *    content-addressed object store shared by the upload service and the storage
 *    port, so the key the manifest names is the key the bytes are under.
 *
 * Only the tenancy edges are fakes: a workspace authorizer, a document record
 * store and a logger. They decide *whether* the request is allowed, never what
 * the document contains.
 */

import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type { DocumentRecord } from "@/src/domain/entities/DocumentRecord";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import { NotFoundError } from "@/src/domain/errors";

const ORG = "org-alpha";
const WORKSPACE = "ws-alpha";
const DOCUMENT = "doc-1";

/** A real content-addressed store: the same key derivation production uses. */
class ContentAddressedStore implements IObjectStorage {
  readonly objects = new Map<string, Buffer>();

  static keyFor(data: Buffer): string {
    const hash = crypto.createHash("sha256").update(data).digest("hex");
    return `ca/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
  }

  async put(key: string, data: Buffer | Uint8Array): Promise<void> {
    this.objects.set(key, Buffer.from(data));
  }
  async get(key: string): Promise<Buffer> {
    const data = this.objects.get(key);
    if (!data) throw new Error(`object ${key} does not exist`);
    return Buffer.from(data);
  }
  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const data = await this.get(key);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(data));
        controller.close();
      },
    });
  }
  async putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    options: { contentType: string; sha256?: string },
  ): Promise<{ sha256: string; size: number }> {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    const data = Buffer.concat(chunks);
    await this.put(key, data);
    return { sha256: options.sha256 ?? "", size: data.byteLength };
  }
  async head(key: string) {
    const data = this.objects.get(key);
    return { key, size: data?.byteLength ?? 0, contentType: null, exists: data !== undefined };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

/** Hoisted with the mocks: the route modules read `Tokens` at import time. */
const TOKENS = vi.hoisted(() => ({
  ObjectStorage: Symbol("ObjectStorage"),
  WorkspaceAwareUploadService: Symbol("WorkspaceAwareUploadService"),
  DocumentIngestionRepository: Symbol("DocumentIngestionRepository"),
}));

const harness = vi.hoisted(() => ({
  /** Set in `beforeEach`; the mocks read through this so each test is isolated. */
  current: null as null | {
    storage: unknown;
    uploads: unknown;
    versions: unknown;
    documents: {
      setRevision(revision: number): void;
      revision(): number;
      getById(
        workspaceId: string,
        documentId: string,
      ): Promise<{ name: string; revision: number } | null>;
    };
  },
  actorOrganizationId: "org-alpha",
}));

vi.mock("@/src/application/di/container", () => ({
  appContainer: {
    resolve: (token: symbol) => {
      const bag = harness.current;
      if (!bag) throw new Error("harness not initialised");
      if (token === TOKENS.ObjectStorage) return bag.storage;
      if (token === TOKENS.WorkspaceAwareUploadService) return bag.uploads;
      if (token === TOKENS.DocumentIngestionRepository) {
        // Consulted only to explain WHY content is unavailable; a document with a
        // usable artifact never reaches it.
        return { getByDocumentId: async () => null, findByDocumentId: async () => null };
      }
      throw new Error(`unexpected token ${String(token)}`);
    },
  },
}));

vi.mock("@/src/application/di/tokens", () => ({ Tokens: TOKENS }));

vi.mock("@/src/application/services/workspaceHttp", async (importOriginal) => {
  const { NextResponse } = await import("next/server");
  const original = await importOriginal<typeof import("./workspaceHttp")>();
  return {
    // Real: the bounded error envelope and the request-id shape are what a client
    // reads, and this suite asserts on the 404 the fallback path depends on.
    ...original,
    requireSameOrigin: () => null,
    // Authentication now precedes the multipart parse, so the save path resolves a
    // session before it resolves an actor. Stubbing only the actor would 401 every
    // save in this suite.
    getSessionUser: async () => ({ user: { id: "user-1" } }),
    getWorkspaceActor: async () => ({
      actor: {
        userId: "user-1",
        organizationId: harness.actorOrganizationId,
        organizationRole: "member",
        organizationDefaultWorkspaceId: null,
      } satisfies ActorContext,
    }),
    workspaceServices: () => ({ audit: { record: async () => {} } }),
    mapWorkspaceError: (_request: unknown, error: unknown) =>
      NextResponse.json(
        { error: { code: "MAPPED", message: error instanceof Error ? error.message : String(error) } },
        { status: 409 },
      ),
  };
});

vi.mock("@/src/application/services/versionHttp", async (importOriginal) => {
  const original = await importOriginal<typeof import("./versionHttp")>();
  return {
    ...original,
    // Only the container lookup is replaced; `createVersion`, `getVersion` and
    // `getLatestVersion` are the real service's.
    versionService: () => harness.current!.versions,
  };
});

/*
 * The content route reads the document RECORD (for `X-Document-Revision`, the
 * fence token the editor writes back with, and for the download name), so this
 * mock must serve the same row the save path fences against. A stub that
 * answers with null — or with a method the real service does not have — makes
 * the header untruthful, which is exactly the confusion between the four
 * revision counters this suite exists to prevent.
 */
vi.mock("@/src/application/services/workspacePageData", () => ({
  pageDocumentService: () => ({
    async get(_actor: unknown, workspaceId: string, documentId: string) {
      const doc = await harness.current!.documents.getById(workspaceId, documentId);
      if (!doc) throw new Error("document not found");
      return doc;
    },
  }),
}));

import { POST as uploadVersion } from "@/app/api/workspaces/[workspaceId]/documents/[documentId]/versions/upload/route";
import { GET as getEditorState } from "@/app/api/workspaces/[workspaceId]/documents/[documentId]/editor-state/route";
import { GET as getContent } from "@/app/api/workspaces/[workspaceId]/documents/[documentId]/content/route";
import { VersionService } from "./VersionService";
import { InMemoryDocumentVersionRepository } from "@/src/infrastructure/persistence/InMemoryDocumentVersionRepository";
import { SerializationService } from "@/src/application/editor/serialization/SerializationService";
import { diffStates } from "@/src/application/editor/serialization/testing/semanticCompare";
import {
  addObjectToPage,
  createEditorState,
  createPage,
  type EditorPage,
  type EditorState,
} from "@/src/domain/editor/document";
import { makeBounds, makeTranslate } from "@/src/domain/editor/geometry";
import { paintOrder } from "@/src/domain/editor/layers";
import type { AnnotationObject, EditorObject } from "@/src/domain/editor/objects";
import {
  makeAnnotation,
  makeDrawing,
  makeImage,
  makeRect,
  makeSignature,
  makeTextObject,
} from "@/src/domain/editor/testFactories";
import { createPlainTextContent } from "@/src/domain/editor/textContent";
import { InMemoryStoredFileRepository } from "@/src/infrastructure/persistence/InMemoryStoredFileRepository";

const codec = new SerializationService();

class SilentLogger implements ILogger {
  debug(_m: string, _f?: LogFields): void {}
  info(_m: string, _f?: LogFields): void {}
  warn(_m: string, _f?: LogFields): void {}
  error(_m: string, _f?: LogFields): void {}
  child(): ILogger {
    return this;
  }
}

/** Authorizes the actor; says nothing about content. */
const workspaces = {
  async get(actor: ActorContext, workspaceId: string) {
    if (workspaceId !== WORKSPACE || actor.organizationId !== ORG) {
      throw new NotFoundError("Workspace not found.");
    }
    return { workspace: { id: workspaceId, organizationId: ORG }, role: "editor" } as unknown as Awaited<
      ReturnType<WorkspaceService["get"]>
    >;
  },
} as unknown as WorkspaceService;

/**
 * The document row, with the SAME revision semantics as the Prisma adapter:
 * `data.revision` is the expected current value (a WHERE guard) and the store
 * increments the column itself.
 */
function documentRepository() {
  let row: DocumentRecord = {
    id: DOCUMENT,
    workspaceId: WORKSPACE,
    organizationId: ORG,
    projectId: null,
    folderId: null,
    name: "Contract.pdf",
    normalizedName: "contract.pdf",
    lifecycleState: "active",
    orderKey: "a0",
    currentVersionId: null,
    favorite: false,
    lastAccessedAt: null,
    createdById: "user-1",
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    trashedAt: null,
    archivedById: null,
    trashedById: null,
  };
  return {
    async getById(workspaceId: string, documentId: string) {
      return workspaceId === WORKSPACE && documentId === DOCUMENT ? { ...row } : null;
    },
    async update(
      _workspaceId: string,
      _documentId: string,
      data: Partial<Pick<DocumentRecord, "currentVersionId" | "revision">>,
    ) {
      if (data.revision !== undefined && data.revision !== row.revision) {
        throw new Error("Document update conflict.");
      }
      row = { ...row, ...data, revision: row.revision + 1 };
      return { ...row };
    },
    setRevision(revision: number) {
      row = { ...row, revision };
    },
    revision() {
      return row.revision;
    },
  };
}

let storage: ContentAddressedStore;
let documents: ReturnType<typeof documentRepository>;

beforeEach(() => {
  storage = new ContentAddressedStore();
  documents = documentRepository();
  harness.actorOrganizationId = ORG;
  const versionRepository = new InMemoryDocumentVersionRepository();
  const uploads = {
    async validateDestination() {
      return true;
    },
    async upload({ data }: { data: Buffer }) {
      // Content-addressed and byte-deduplicated, exactly as production is: the
      // same bytes saved twice occupy one key.
      const key = ContentAddressedStore.keyFor(data);
      await storage.put(key, data);
      return { file: { key } };
    },
  };
  harness.current = {
    storage,
    uploads,
    documents,
    versions: new VersionService(
      new SilentLogger(),
      workspaces,
      versionRepository,
      documents as never,
      storage,
      new InMemoryStoredFileRepository(),
    ),
  };
});

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/** A genuine PDF signature: the route checks it, and a scene needs bytes under it. */
const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "ascii");
const FLATTENED_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Flat true >>\nendobj\n%%EOF\n", "ascii");

function pageOf(id: string, objects: EditorObject[], overrides: Partial<EditorPage> = {}): EditorPage {
  let page: EditorPage = { ...createPage(id), ...overrides };
  for (const object of objects) page = addObjectToPage(page, object);
  return page;
}

function yellowNote(id = "note-1"): AnnotationObject {
  return makeAnnotation({
    id,
    text: "this is note",
    fontSize: 13,
    opacity: 0.85,
    background: { r: 1, g: 0.85, b: 0.2, a: 0.9 },
    border: { r: 0.6, g: 0.45, b: 0, a: 1 },
    borderWidth: 2,
    cornerRadius: 6,
    pointerTarget: { x: 220, y: 40 },
    transform: makeTranslate(72, 120),
    localBounds: makeBounds(0, 0, 180, 52),
  });
}

/** The complex document: one of every kind, over two pages, nothing defaulted. */
function liveState(): EditorState {
  const pages = [
    pageOf(
      "page-1",
      [
        makeTextObject({
          id: "text-1",
          content: createPlainTextContent("clause one\nclause two"),
          fontSize: 14.5,
          fontFamily: "Times",
          fontWeight: 600,
          align: "right",
          lineHeight: 1.35,
          letterSpacing: 0.5,
          wordSpacing: 2,
          paragraphSpacing: 5,
          background: null,
          sourceText: null,
          opacity: 0.92,
        }),
        makeImage({ id: "image-1", crop: makeBounds(7, 9, 84, 37), opacity: 0.6 }),
        yellowNote(),
        makeSignature({ id: "sig-1", signer: "Ada", opacity: 0.95 }),
        makeRect({ id: "star-1", shape: "star", starPoints: 6, innerRatio: 0.38 }),
        makeDrawing({ id: "draw-1", brush: "marker", widths: [1.5, 3, 2.25], opacity: 0.65 }),
      ],
      { sourcePageIndex: 0, rotation: 90 },
    ),
    pageOf("page-2", [makeRect({ id: "arrow-2", shape: "arrow", headSize: 18, headType: "open" })], {
      sourcePageIndex: 1,
      width: 420,
      height: 595,
    }),
  ];
  const base = createEditorState("doc-workspace", "page-1");
  return {
    ...base,
    document: { ...base.document, pages },
    selection: { ids: ["note-1"], primaryId: "note-1" },
  };
}

// ---------------------------------------------------------------------------
// The HTTP calls, as a client makes them.
// ---------------------------------------------------------------------------

const params = Promise.resolve({ workspaceId: WORKSPACE, documentId: DOCUMENT });
const BASE = `http://localhost:3001/api/workspaces/${WORKSPACE}/documents/${DOCUMENT}`;

interface SaveOptions {
  state?: EditorState;
  expectedRevision?: number;
  /** Omitted to reproduce a bytes-only save from an older client. */
  scene?: string | null;
  source?: Buffer | null;
  output?: Buffer;
}

async function save(options: SaveOptions = {}) {
  const form = new FormData();
  const output = options.output ?? FLATTENED_BYTES;
  form.set("file", new File([new Uint8Array(output)], "document.pdf", { type: "application/pdf" }));
  form.set("expectedRevision", String(options.expectedRevision ?? documents.revision()));
  if (options.scene !== null) {
    form.set(
      "scene",
      options.scene ?? JSON.stringify(codec.serialize(options.state ?? liveState())),
    );
  }
  if (options.source !== null) {
    const source = options.source ?? PDF_BYTES;
    form.set("source", new File([new Uint8Array(source)], "source.pdf", { type: "application/pdf" }));
  }
  const response = await uploadVersion(
    new NextRequest(`${BASE}/versions/upload`, { method: "POST", body: form }),
    { params },
  );
  return { response, body: (await response.json()) as Record<string, never> };
}

/**
 * `organizationId` is required on every read: it is what scopes the actor before
 * a version is resolved, so a request without it is rejected rather than
 * defaulted to some organization.
 */
function readUrl(path: string, query: string): string {
  const separator = query.startsWith("?") ? "&" : "?";
  return `${BASE}/${path}${query}${separator}organizationId=${ORG}`;
}

function editorState(query = "") {
  return getEditorState(new NextRequest(readUrl("editor-state", query)), { params });
}

function content(query = "") {
  return getContent(new NextRequest(readUrl("content", query)), { params });
}

async function bytesOf(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// T13.
// ---------------------------------------------------------------------------

describe("T13 Workspace scene round trip", () => {
  it("save then reopen returns the same document, property for property", async () => {
    const before = liveState();
    const { response } = await save({ state: before });
    expect(response.status).toBe(201);

    const reopened = await editorState();
    expect(reopened.status).toBe(200);
    expect(reopened.headers.get("content-type")).toContain("application/json");

    const after = codec.deserialize(JSON.parse((await bytesOf(reopened)).toString("utf8")));
    // The whole claim of the phase, in one assertion: the document that comes
    // back out of a Workspace version is the document that went in.
    expect(diffStates(before, after)).toEqual([]);
  });

  it("the reopened annotation still has its yellow container", async () => {
    // The recorded regression, asserted at the boundary it was lost at. Reopen
    // used to re-import the flattened PDF, and the panel had no representation
    // to re-import.
    await save();
    const after = codec.deserialize(JSON.parse((await bytesOf(await editorState())).toString("utf8")));
    const note = after.document.pages[0].objects["note-1"] as AnnotationObject;
    expect(note.kind).toBe("annotation");
    expect(note.text).toBe("this is note");
    expect(note.background).toEqual({ r: 1, g: 0.85, b: 0.2, a: 0.9 });
    expect(note.borderWidth).toBe(2);
    expect(note.cornerRadius).toBe(6);
    expect(note.opacity).toBe(0.85);
  });

  it("stores the scene byte-identically, so reopening is a restore and not a re-parse", async () => {
    const sent = JSON.stringify(codec.serialize(liveState()));
    await save({ scene: sent });
    const served = (await bytesOf(await editorState())).toString("utf8");
    expect(served).toBe(sent);
  });

  it("writes all three artifact slots, each naming different bytes", async () => {
    await save();
    // `source` = the bytes the scene overlays; `output` = the flattened PDF the
    // Workspace publishes; `editorState` = the scene. Conflating any two is how
    // a reopen ends up parsing the flattened output.
    const sourceResponse = await content("?artifact=source");
    const outputResponse = await content("");
    expect(sourceResponse.status).toBe(200);
    expect(outputResponse.status).toBe(200);
    // The bytes travel with the fence token the next save must quote. It is the
    // RECORD's revision, not the version number: reading it off the wrong
    // counter is how an editor's own write comes back as a conflict.
    expect(outputResponse.headers.get("X-Document-Revision")).toBe(String(documents.revision()));
    expect(outputResponse.headers.get("X-Document-Version")).toBe("1");
    expect(await bytesOf(sourceResponse)).toEqual(PDF_BYTES);
    expect(await bytesOf(outputResponse)).toEqual(FLATTENED_BYTES);
    // …and the scene is neither of them.
    const scene = await bytesOf(await editorState());
    expect(scene.subarray(0, 5).toString("ascii")).not.toBe("%PDF-");
  });

  it("preserves z-order, page order and page geometry across the reopen", async () => {
    const before = liveState();
    await save({ state: before });
    const after = codec.deserialize(JSON.parse((await bytesOf(await editorState())).toString("utf8")));

    expect(paintOrder(after.document.pages[0].layerStack).map((e) => e.objectId)).toEqual(
      paintOrder(before.document.pages[0].layerStack).map((e) => e.objectId),
    );
    expect(after.document.pages.map((p) => p.id)).toEqual(["page-1", "page-2"]);
    expect(after.document.pages.map((p) => p.sourcePageIndex)).toEqual([0, 1]);
    expect(after.document.pages.map((p) => p.rotation)).toEqual([90, 0]);
    expect(after.document.pages.map((p) => [p.width, p.height])).toEqual([
      [595, 842],
      [420, 595],
    ]);
  });

  it("a second save wins, and reopening never serves the first version's scene", async () => {
    // Scenario D as a unit test: two versions of the same document, one property
    // changed. `editor-state` with no version number must serve the LATEST.
    const first = liveState();
    await save({ state: first });

    const edited: EditorState = {
      ...first,
      document: {
        ...first.document,
        pages: [
          {
            ...first.document.pages[0],
            objects: {
              ...first.document.pages[0].objects,
              "note-1": {
                ...(first.document.pages[0].objects["note-1"] as AnnotationObject),
                background: { r: 0.2, g: 0.6, b: 1, a: 0.9 },
                text: "edited note",
              },
            },
          },
          first.document.pages[1],
        ],
      },
    };
    await save({ state: edited });

    const latest = codec.deserialize(JSON.parse((await bytesOf(await editorState())).toString("utf8")));
    const note = latest.document.pages[0].objects["note-1"] as AnnotationObject;
    expect(note.text).toBe("edited note");
    expect(note.background).toEqual({ r: 0.2, g: 0.6, b: 1, a: 0.9 });
    expect(diffStates(edited, latest)).toEqual([]);

    // The earlier version is still addressable and still holds the earlier
    // document — an immutable checkpoint, not a mutated one.
    const older = codec.deserialize(
      JSON.parse((await bytesOf(await editorState("?version=1"))).toString("utf8")),
    );
    expect((older.document.pages[0].objects["note-1"] as AnnotationObject).text).toBe("this is note");
    expect(diffStates(first, older)).toEqual([]);
  });

  it("a version saved without a scene reports 404, so the client falls back to the PDF", async () => {
    // Every version written before scenes were stored, and every version written
    // by import, legitimately has no editable state. An empty scene here would
    // look like a document whose objects were all deleted.
    await save({ scene: null, source: null });
    const response = await editorState();
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("EDITOR_STATE_UNAVAILABLE");
    // The PDF is still there — that is what makes the fallback usable.
    expect((await content("")).status).toBe(200);
  });

  it("a bytes-only save still publishes its bytes as the source", async () => {
    // The pre-existing behaviour, unchanged: with no separate original the
    // published bytes ARE the source, and `artifact=source` must not 404.
    await save({ scene: null, source: null, output: PDF_BYTES });
    expect(await bytesOf(await content("?artifact=source"))).toEqual(PDF_BYTES);
  });

  it("refuses a scene that is not editor state, before it can become an artifact", async () => {
    const response = (await save({ scene: JSON.stringify({ hello: "world" }) })).response;
    expect(response.status).toBe(422);
    // Nothing was committed, so the reopen path is unchanged rather than
    // pointing at a stored blob that is not a scene.
    expect((await editorState()).status).toBe(404);
  });

  it("never echoes a storage key, and identifies the scene only by version number", async () => {
    // Objects are content-addressed, so a KEY is a storage location a client must
    // never learn or be able to name. (The version response does carry artifact
    // CHECKSUMS — pre-existing Phase 2 behaviour, and what lets a client verify a
    // download; the scene route deliberately carries neither.)
    const { body } = await save();
    expect(JSON.stringify(body)).not.toContain("ca/");

    const scene = await editorState();
    expect(scene.headers.get("x-document-version")).toBe("1");
    for (const [name, value] of scene.headers.entries()) {
      expect(value, `header ${name} leaks a key`).not.toContain("ca/");
      expect(value, `header ${name} leaks a checksum`).not.toMatch(/[0-9a-f]{64}/);
    }
  });

  it("does not cache tenant scene bytes in a shared or browser cache", async () => {
    await save();
    const response = await editorState();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("rejects a save built on a stale revision instead of overwriting", async () => {
    // The compare-and-swap is the client's claim about what it read. A save on a
    // stale document is a conflict the user resolves, never a silent overwrite of
    // someone else's version.
    await save();
    const stale = await save({ expectedRevision: 1 });
    expect(stale.response.status).toBe(409);
  });

  it("stores one copy of an unchanged scene saved twice", async () => {
    // The performance guardrail with teeth: identical bytes dedupe to one key, so
    // "save twice, changed nothing" costs no storage.
    const state = liveState();
    await save({ state });
    const keysAfterFirst = storage.objects.size;
    await save({ state });
    expect(storage.objects.size).toBe(keysAfterFirst);
  });

  it("a foreign organization sees no scene at all", async () => {
    await save();
    harness.actorOrganizationId = "org-intruder";
    // Reported as missing, not as forbidden: the service resolves the version
    // inside the actor's Workspace, so a foreign document does not exist.
    const response = await editorState();
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain("this is note");
  });
});
