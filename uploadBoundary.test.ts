import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

/**
 * S1–S18 — the upload boundary, observed rather than read.
 *
 * The finding this suite closes: all three PRIVATE Workspace upload routes
 * parsed a multipart body before checking whether the caller was signed in, and
 * none of them was rate limited while the PUBLIC tool route was. The evidence
 * log `docs/evidence/final-prelaunch/anonymous-parse-workspace-uploads.log`
 * measured an anonymous 8 MiB body being buffered and parsed for a caller that
 * held no session at all.
 *
 * WHY THE READ COUNTER IS THE POINT. "Authentication happens first" is not
 * observable from a status code: a route that parses 8 MiB and then answers 401
 * returns the same 401 as a route that answers before reading a byte. Every
 * request below therefore carries a body whose stream counts its own `pull()`
 * calls, and the assertion is `reads() === 0` — the boundary is proved by what
 * the server did NOT read. `pulled()` measures the same thing in bytes, which is
 * what makes the streaming ceiling a measurement rather than a claim.
 *
 * The gate, the reader, the limiter and the CSRF check are all REAL here. Only
 * the DI container and the worker bootstrap are stubbed, so what is under test
 * is the request path a browser actually takes.
 */

const state = vi.hoisted(() => ({
  /** Every service call the routes can make, in order. Empty = nothing happened. */
  calls: [] as string[],
  /** token -> user, so a cookie is the only thing that can authenticate. */
  sessions: {} as Record<string, { id: string } | undefined>,
  orgs: [{ id: "org-1", defaultWorkspaceId: null as string | null }],
  role: "admin" as string | null,
  destinationOk: true,
  uploadedBytes: null as Buffer | null,
  attachmentData: null as Buffer | null,
  attachmentName: null as string | null,
  auditMetadata: null as unknown,
  logs: [] as string[],
}));

vi.mock("@/src/application/di/container", () => ({
  appContainer: {
    // One fat stub for every token: the method names do not collide, and a
    // per-token switch would be more wiring for the same behaviour.
    resolve: () => ({
      getMe: async (token: string) => state.sessions[token] ?? null,
      listForUser: async () => state.orgs,
      getRole: async () => state.role,
      validateDestination: async () => {
        state.calls.push("validateDestination");
        return state.destinationOk;
      },
      upload: async ({ data }: { data: Buffer }) => {
        state.calls.push("upload");
        state.uploadedBytes = data;
        return { file: { id: "file-1", key: "stored/key.pdf" } };
      },
      uploadToWorkspace: async (_actor: unknown, _ws: string, input: { data: Buffer }) => {
        state.calls.push("uploadToWorkspace");
        state.uploadedBytes = input.data;
        return { deduplicated: false, document: { id: "doc-1", name: "document.pdf" } };
      },
      createAttachment: async (
        _actor: unknown,
        _ws: string,
        _doc: string,
        input: { data: Buffer; name: string; mimeType: string },
      ) => {
        state.calls.push("createAttachment");
        state.attachmentData = input.data;
        state.attachmentName = input.name;
        // Shaped for the REAL `toAttachmentResponse`, which the route calls.
        return {
          id: "att-1",
          workspaceId: "ws-1",
          documentId: "doc-1",
          storedFileId: "file-1",
          origin: "user",
          name: input.name,
          description: null,
          mimeType: input.mimeType,
          byteSize: input.data.byteLength,
          checksum: "checksum",
          revision: 1,
          createdById: "user-1",
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
      },
      createVersion: async () => {
        state.calls.push("createVersion");
        // Shaped for the REAL `toVersionResponse`.
        return {
          id: "version-1",
          documentId: "doc-1",
          versionNumber: 2,
          revision: 1,
          origin: "save",
          restoredFromVersionId: null,
          label: null,
          manifestDegraded: false,
          checksum: "checksum",
          manifest: {
            sourceChecksum: "source-checksum",
            sourceByteSize: 16,
            pageCount: null,
            thumbnailKeys: [],
            editorStateKey: null,
            outputKey: null,
          },
          createdById: "user-1",
          createdAt: new Date(0),
          documentRevision: 4,
        };
      },
      record: async (entry: { metadata?: unknown }) => {
        state.calls.push("audit.record");
        state.auditMetadata = entry.metadata;
      },
      info: (...args: unknown[]) => state.logs.push(args.map(String).join(" ")),
      warn: (...args: unknown[]) => state.logs.push(args.map(String).join(" ")),
      error: (...args: unknown[]) => state.logs.push(args.map(String).join(" ")),
    }),
  },
}));

vi.mock("@/src/infrastructure/jobs/workerBootstrap", () => ({
  ensureWorkerReady: () => state.calls.push("ensureWorkerReady"),
}));

import { _resetConfigForTests } from "@/src/infrastructure/config/env";
import {
  MalformedMultipartError,
  MultipartTooLargeError,
  multipartFailure,
  multipartToolResponse,
  readMultipart,
} from "@/lib/server/multipart";
import { PROXY_SECRET_HEADER, _resetUploadLimitsForTests } from "@/lib/server/uploadRateLimit";

import { POST as attachmentsPOST } from "@/app/api/workspaces/[workspaceId]/documents/[documentId]/attachments/route";
import { POST as documentsPOST } from "@/app/api/workspaces/[workspaceId]/documents/upload/route";
import { POST as versionsPOST } from "@/app/api/workspaces/[workspaceId]/documents/[documentId]/versions/upload/route";

const WS = "ws-1";
const DOC = "doc-1";
const SESSION = "session-token-1";
const USER = "user-1";
const ORIGIN = "http://localhost:3000";
const PDF = Buffer.from("%PDF-1.7\n%%EOF\n", "ascii");
const MiB = 1024 * 1024;

/**
 * A stream that reports how much of itself the server actually asked for.
 *
 * `highWaterMark: 0` is load-bearing. A default stream's queue prefetches one
 * chunk from its source as soon as it starts, with or without a reader, so with
 * the default strategy every request below would show one 64 KiB read that no
 * server code asked for — a measurement artifact of the harness that would sit
 * exactly where the finding is. Zero desired size means `pull` runs only when a
 * consumer actually reads, which is what a real socket does.
 */
function counted(bytes: Buffer, chunkSize = 64 * 1024) {
  let reads = 0;
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads += 1;
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkSize, bytes.length);
        controller.enqueue(new Uint8Array(bytes.subarray(offset, end)));
        offset = end;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, reads: () => reads, pulled: () => offset, chunkSize };
}

/** Real multipart bytes, with the boundary the encoder chose. */
async function multipartBody(
  parts: Record<string, string | File>,
): Promise<{ bytes: Buffer; contentType: string }> {
  const form = new FormData();
  for (const [key, value] of Object.entries(parts)) form.set(key, value);
  const encoded = new Response(form);
  return {
    bytes: Buffer.from(await encoded.arrayBuffer()),
    contentType: encoded.headers.get("content-type")!,
  };
}

function file(bytes: Buffer, name = "document.pdf", type = "application/pdf") {
  return new File([new Uint8Array(bytes)], name, { type });
}

interface RouteUnderTest {
  name: string;
  path: string;
  /** The route file, for S1's inventory. Spelled out rather than derived. */
  source: string;
  /** Fields that make a request VALID for this route, next to the `file` part. */
  validFields: Record<string, string>;
  tooLargeMessage: string;
  invokeRaw: (request: NextRequest) => Promise<Response>;
}

const ROUTES: RouteUnderTest[] = [
  {
    name: "attachments",
    path: `/api/workspaces/${WS}/documents/${DOC}/attachments`,
    source: "app/api/workspaces/[workspaceId]/documents/[documentId]/attachments/route.ts",
    validFields: { organizationId: "org-1" },
    tooLargeMessage: "This attachment is too large.",
    invokeRaw: (request) =>
      attachmentsPOST(request, {
        params: Promise.resolve({ workspaceId: WS, documentId: DOC }),
      }) as Promise<Response>,
  },
  {
    name: "documents/upload",
    path: `/api/workspaces/${WS}/documents/upload`,
    source: "app/api/workspaces/[workspaceId]/documents/upload/route.ts",
    validFields: {},
    tooLargeMessage: "Upload too large.",
    invokeRaw: (request) =>
      documentsPOST(request, { params: Promise.resolve({ workspaceId: WS }) }) as Promise<Response>,
  },
  {
    name: "versions/upload",
    path: `/api/workspaces/${WS}/documents/${DOC}/versions/upload`,
    source: "app/api/workspaces/[workspaceId]/documents/[documentId]/versions/upload/route.ts",
    validFields: { expectedRevision: "3" },
    tooLargeMessage: "Upload too large.",
    invokeRaw: (request) =>
      versionsPOST(request, {
        params: Promise.resolve({ workspaceId: WS, documentId: DOC }),
      }) as Promise<Response>,
  },
];

interface CallOptions {
  /** Omit for an anonymous caller — the only way to authenticate is this cookie. */
  cookie?: string;
  origin?: string | null;
  contentType?: string;
  /** Sent verbatim, including a value that contradicts the real body. */
  contentLength?: string;
  headers?: Record<string, string>;
  chunkSize?: number;
}

/**
 * Drives one route with a body whose consumption is measured.
 *
 * The request is built with a STREAM body and no `Content-Length` unless one is
 * asked for, which is exactly what `Transfer-Encoding: chunked` looks like to the
 * handler: nothing has declared how many bytes are coming.
 */
async function call(
  route: RouteUnderTest,
  body: { bytes: Buffer; contentType: string },
  options: CallOptions = {},
) {
  const meter = counted(body.bytes, options.chunkSize);
  const headers: Record<string, string> = {
    "content-type": options.contentType ?? body.contentType,
    ...(options.headers ?? {}),
  };
  if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
  if (options.cookie) headers.cookie = `pdfdadi_session=${options.cookie}`;
  if (options.contentLength !== undefined) headers["content-length"] = options.contentLength;
  const request = new NextRequest(`${ORIGIN}${route.path}`, {
    method: "POST",
    headers,
    body: meter.stream,
    duplex: "half",
  } as never);
  const response = await route.invokeRaw(request);
  return {
    response,
    meter,
    // A second, independent witness: `readMultipart` is the only thing that calls
    // `getReader()` on this body, so an unlocked stream means no reader was ever
    // attached — true regardless of any queueing subtlety in the harness.
    bodyLocked: request.body?.locked === true,
    body: (await response.json()) as { error?: { code: string; message: string } },
  };
}

/** A body every route accepts: a real PDF plus that route's required fields. */
function validBody(route: RouteUnderTest, bytes: Buffer = PDF, name?: string) {
  return multipartBody({ ...route.validFields, file: file(bytes, name) });
}

const env = process.env as Record<string, string | undefined>;
const ENV_KEYS = [
  "UPLOAD_RATE_LIMIT_PER_MIN",
  "UPLOAD_ANON_RATE_LIMIT_PER_MIN",
  "UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN",
  "TRUSTED_PROXY_SECRET",
] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  state.calls = [];
  state.sessions = { [SESSION]: { id: USER } };
  state.orgs = [{ id: "org-1", defaultWorkspaceId: null }];
  state.role = "admin";
  state.destinationOk = true;
  state.uploadedBytes = null;
  state.attachmentData = null;
  state.attachmentName = null;
  state.auditMetadata = null;
  state.logs = [];
  for (const key of ENV_KEYS) {
    ORIGINAL_ENV[key] = env[key];
    delete env[key];
  }
  _resetConfigForTests();
  // Module-level limiters: without this reset one test's spent budget refuses
  // the next test's first request, and the suite's order becomes a dependency.
  _resetUploadLimitsForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete env[key];
    else env[key] = ORIGINAL_ENV[key];
  }
  _resetConfigForTests();
  _resetUploadLimitsForTests();
});

/** Shipped `.ts`/`.tsx` under the app's own source roots. Tests excluded. */
function shippedSources(): string[] {
  const roots = ["app", "lib", "src", "components", "data", "test"];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  for (const root of roots) walk(root);
  return out;
}

/**
 * S1 — INVENTORY.
 *
 * The one assertion in this suite that cannot be made by sending a request:
 * "no OTHER code reads a multipart body" is an absence, and an absence is proved
 * by looking everywhere rather than by exercising one place. A sixth call site
 * added tomorrow gets its own guard or fails here.
 */
describe("S1 — every multipart read in shipped code goes through one reader", () => {
  const sources = shippedSources();

  it("finds `.formData()` in exactly one shipped file", () => {
    const callers = sources.filter((f) => /\.formData\(\)/.test(readFileSync(f, "utf8")));
    expect(callers).toEqual(["lib/server/multipart.ts"]);
  });

  it("routes every shipped caller of the reader through the gate or a submit path", () => {
    const readers = sources.filter((f) => /readMultipart\(/.test(readFileSync(f, "utf8"))).sort();
    expect(readers).toEqual([
      "lib/server/multipart.ts",
      "lib/server/processingJobSubmit.ts",
      "lib/server/toolJobSubmit.ts",
      "lib/server/workspaceUploadGate.ts",
    ]);
  });

  it("gives all three private upload routes the same gate", () => {
    for (const route of ROUTES) {
      expect(sources, route.name).toContain(route.source);
      expect(readFileSync(route.source, "utf8"), route.name).toContain(
        "await workspaceUploadGate(request, {",
      );
    }
  });
});

/**
 * S2 — AN ANONYMOUS CALLER GETS NOTHING PARSED ON ITS BEHALF.
 *
 * This is the finding, inverted into a test. The evidence log measured an 8 MiB
 * anonymous body being parsed on `attachments`; the same 8 MiB is posted here to
 * all three routes and the stream is never touched.
 */
describe("S2 — anonymous upload: 401 before the body is read", () => {
  it.each(ROUTES)("$name reads zero bytes of an 8 MiB anonymous body", async (route) => {
    const body = await multipartBody({
      ...route.validFields,
      file: file(Buffer.alloc(8 * MiB, 0x41), "eight-mib.pdf"),
    });
    expect(body.bytes.length).toBeGreaterThan(8 * MiB);

    const attempt = await call(route, body);
    const { response, meter, body: json } = attempt;

    expect(response.status).toBe(401);
    expect(attempt.bodyLocked).toBe(false);
    expect(json.error).toMatchObject({
      code: "UNAUTHORIZED",
      message: "Authentication is required.",
    });
    // The measurement the finding turns on: not one pull of the body stream.
    expect(meter.reads()).toBe(0);
    expect(meter.pulled()).toBe(0);
    // No storage write, no ingestion, no version, no audit line, no save intent,
    // and not even the idempotent worker bootstrap.
    expect(state.calls).toEqual([]);
    expect(state.uploadedBytes).toBeNull();
    expect(state.attachmentData).toBeNull();
    expect(state.auditMetadata).toBeNull();
  });

  it("refuses a cookie that names no session, still without reading", async () => {
    const route = ROUTES[1];
    const { response, meter, body: json } = await call(route, await validBody(route), {
      cookie: "not-a-real-session",
    });
    expect(response.status).toBe(401);
    expect(json.error?.code).toBe("UNAUTHORIZED");
    expect(meter.reads()).toBe(0);
    expect(state.calls).toEqual([]);
  });
});

/**
 * S3 — CSRF IS AHEAD OF EVERYTHING, INCLUDING A VALID SESSION.
 *
 * The cookie below is good. If the origin check moved after the parse, this test
 * would read the body and still answer 403 — the status alone cannot tell the two
 * orders apart, which is why the counter is the assertion.
 */
describe("S3 — foreign origin: 403 before the body is read", () => {
  it.each(ROUTES)("$name refuses a foreign origin without reading", async (route) => {
    const { response, meter, body: json } = await call(route, await validBody(route), {
      cookie: SESSION,
      origin: "https://evil.example",
    });
    expect(response.status).toBe(403);
    expect(json.error).toMatchObject({
      code: "CSRF_ORIGIN_REJECTED",
      message: "Request origin is not allowed.",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(meter.reads()).toBe(0);
    expect(state.calls).toEqual([]);
  });

  it("refuses a request that claims no origin at all", async () => {
    const route = ROUTES[0];
    const { response, meter, body: json } = await call(route, await validBody(route), {
      cookie: SESSION,
      origin: null,
    });
    expect(response.status).toBe(403);
    expect(json.error?.code).toBe("CSRF_ORIGIN_REQUIRED");
    expect(meter.reads()).toBe(0);
  });
});

/**
 * S4 — A DECLARED OVERSIZE IS REFUSED BEFORE CONSUMPTION.
 *
 * The cheap half of the ceiling: one header read, and the request is over before
 * the client has sent anything. S9/S10 cover the half that does not trust the
 * header.
 */
describe("S4 — declared oversize: 413 before consumption", () => {
  it.each(ROUTES)("$name refuses an over-ceiling Content-Length unread", async (route) => {
    const { response, meter, body: json } = await call(route, await validBody(route), {
      cookie: SESSION,
      contentLength: String(200 * MiB),
    });
    expect(response.status).toBe(413);
    expect(json.error).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      message: route.tooLargeMessage,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(meter.reads()).toBe(0);
    expect(state.calls).toEqual([]);
  });

  it("refuses 26 MiB declared on the 25 MiB attachment route", async () => {
    const route = ROUTES[0];
    const { response, meter } = await call(route, await validBody(route), {
      cookie: SESSION,
      contentLength: String(26 * MiB),
    });
    expect(response.status).toBe(413);
    expect(meter.reads()).toBe(0);
  });
});

/**
 * S5 — A RATE-LIMITED CALLER GETS NOTHING PARSED EITHER.
 *
 * Both buckets, because they are refused at different stages: the signed-in user
 * is charged their own key (the session resolved first), and everyone else shares
 * the unspoofable global one.
 */
describe("S5 — rate limited: 429 before the body is read", () => {
  it("refuses a signed-in user's second upload within the window", async () => {
    env.UPLOAD_RATE_LIMIT_PER_MIN = "1";
    _resetConfigForTests();
    _resetUploadLimitsForTests();
    const route = ROUTES[1];

    const first = await call(route, await validBody(route), { cookie: SESSION });
    expect(first.response.status).toBe(201);
    expect(first.meter.reads()).toBeGreaterThan(0);

    state.calls = [];
    const second = await call(route, await validBody(route), { cookie: SESSION });
    expect(second.response.status).toBe(429);
    expect(second.body.error).toMatchObject({
      code: "RATE_LIMITED",
      message: "Too many uploads. Please wait and try again.",
    });
    expect(second.response.headers.get("cache-control")).toBe("no-store");
    expect(Number(second.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(second.meter.reads()).toBe(0);
    expect(state.calls).toEqual([]);
  });

  it("refuses anonymous traffic on the global bucket before it is authenticated", async () => {
    env.UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN = "2";
    _resetConfigForTests();
    _resetUploadLimitsForTests();
    const route = ROUTES[0];
    const body = await validBody(route);

    for (const attempt of [1, 2]) {
      const { response } = await call(route, body);
      expect(response.status, `attempt ${attempt}`).toBe(401);
    }
    const third = await call(route, body);
    // The 429 arrives INSTEAD of the 401: an unauthenticated flood has to be
    // countable for the count to bound anything.
    expect(third.response.status).toBe(429);
    expect(third.meter.reads()).toBe(0);
    expect(state.calls).toEqual([]);
  });
});

/**
 * A body no parser can read, built by hand.
 *
 * The raw `"` in the filename is the exact input from the evidence log: undici
 * rejects the part header, and before this work that rejection reached the client
 * as 422 "A multipart upload is required." on one route and 400 "Malformed
 * multipart body." on another — the same bytes, two answers, one of them
 * describing the wrong cause.
 */
function hostileFilenameBody(): { bytes: Buffer; contentType: string } {
  const boundary = "----pdfdadiBoundary1234";
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="ho"stile.pdf"\r\n` +
    `Content-Type: application/pdf\r\n\r\n` +
    `%PDF-1.7\n%%EOF\n\r\n` +
    `--${boundary}--\r\n`;
  return {
    bytes: Buffer.from(body, "utf8"),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** A declared boundary that never appears: nothing to parse at all. */
function absentBoundaryBody(): { bytes: Buffer; contentType: string } {
  return {
    bytes: Buffer.from("this is not a multipart body at all", "utf8"),
    contentType: "multipart/form-data; boundary=----pdfdadiMissing",
  };
}

/**
 * S6 — ONE MALFORMED BODY, ONE ANSWER, ON EVERY ROUTE.
 *
 * The P3 the audit recorded next to the P1: the inconsistency was cosmetic, but
 * "a multipart upload is required" was also untrue — one was supplied. Both the
 * status and the wording are pinned here, on all three routes, for both shapes of
 * unreadable body.
 */
describe("S6 — malformed multipart is 400 MALFORMED_MULTIPART everywhere", () => {
  for (const [label, make] of [
    ["a raw quote in the filename", hostileFilenameBody],
    ["a boundary that never appears", absentBoundaryBody],
  ] as const) {
    it.each(ROUTES)(`$name answers 400 for ${label}`, async (route) => {
      const { response, body: json } = await call(route, make(), { cookie: SESSION });
      expect(response.status).toBe(400);
      expect(json.error).toMatchObject({
        code: "MALFORMED_MULTIPART",
        message: "Malformed multipart body.",
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      // Unreadable means nothing downstream ran.
      expect(state.calls.filter((c) => c !== "ensureWorkerReady")).toEqual([]);
    });
  }

  it("answers the same on all three routes for the same bytes", async () => {
    const malformed = hostileFilenameBody();
    const answers = [];
    for (const route of ROUTES) {
      const { response, body: json } = await call(route, malformed, { cookie: SESSION });
      answers.push(`${response.status} ${json.error?.code} ${json.error?.message}`);
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toBe("400 MALFORMED_MULTIPART Malformed multipart body.");
  });
});

/**
 * S7 — A WELL-FORMED BODY WITH BAD FIELDS IS 422, AND ONLY THEN.
 *
 * The distinction 400 and 422 have to keep: 400 means "could not be read", 422
 * means "read fine, the contents are wrong". A 422 therefore MUST show a consumed
 * body — a 422 with an unread body would mean the route was guessing.
 */
describe("S7 — well-formed body, invalid fields: 422", () => {
  const CASES: { route: RouteUnderTest; parts: Record<string, string | File>; message: string }[] = [
    { route: ROUTES[0], parts: { file: file(PDF) }, message: "Invalid attachment fields." },
    { route: ROUTES[1], parts: { name: "x" }, message: "A `file` part is required." },
    {
      route: ROUTES[2],
      parts: { file: file(PDF) },
      message: "An integer `expectedRevision` is required.",
    },
  ];

  it.each(CASES)("$route.name answers 422 after parsing", async ({ route, parts, message }) => {
    const attempt = await call(route, await multipartBody(parts), { cookie: SESSION });
    expect(attempt.response.status).toBe(422);
    expect(attempt.body.error).toMatchObject({ code: "INVALID_INPUT", message });
    // Read, then rejected: the opposite of every case above.
    expect(attempt.meter.reads()).toBeGreaterThan(0);
    expect(attempt.bodyLocked).toBe(true);
    expect(state.calls.filter((c) => c !== "ensureWorkerReady")).toEqual([]);
  });
});

/**
 * S8 — THE WRONG MEDIA TYPE IS 415, WITHOUT PARSING.
 *
 * A stage none of the three routes had: a JSON body used to be handed to the
 * multipart parser to discover it was not multipart.
 */
describe("S8 — wrong media type: 415 before the body is read", () => {
  it.each(ROUTES)("$name refuses application/json unread", async (route) => {
    const attempt = await call(
      route,
      { bytes: Buffer.from('{"file":"nope"}'), contentType: "application/json" },
      { cookie: SESSION },
    );
    expect(attempt.response.status).toBe(415);
    expect(attempt.body.error).toMatchObject({
      code: "INVALID_INPUT",
      message: "Expected a multipart/form-data upload.",
    });
    expect(attempt.response.headers.get("cache-control")).toBe("no-store");
    expect(attempt.meter.reads()).toBe(0);
    expect(attempt.bodyLocked).toBe(false);
    expect(state.calls).toEqual([]);
  });

  // The one place the implemented order differs from the brief's stage list, so it
  // is pinned rather than argued: the media type is a header read and the session
  // is a database lookup, so a caller that cannot possibly be served is refused
  // without spending one. It discloses nothing — the answer is about the caller's
  // own request shape, and is the same for a workspace that does not exist.
  it("answers 415 before 401 for an anonymous caller with the wrong media type", async () => {
    const attempt = await call(ROUTES[0], {
      bytes: Buffer.from("{}"),
      contentType: "application/json",
    });
    expect(attempt.response.status).toBe(415);
    expect(attempt.meter.reads()).toBe(0);
    expect(state.calls).toEqual([]);
  });
});

/** The attachment route's real ceiling: the payload cap plus envelope headroom. */
const ATTACHMENT_CEILING = 25 * MiB + 64 * 1024;

/** Built once — 26 MiB of body is the cheapest thing that crosses that ceiling. */
let oversizeBody: { bytes: Buffer; contentType: string } | null = null;
async function oversize() {
  oversizeBody ??= await multipartBody({
    organizationId: "org-1",
    file: file(Buffer.alloc(26 * MiB, 0x41), "big.pdf"),
  });
  return oversizeBody;
}

/**
 * S9 — A DISHONEST `Content-Length` BUYS NOTHING.
 *
 * The header is a claim, and the audit's own evidence had the ceiling resting on
 * it: a 0.03s refusal of a DECLARED 26 MiB proved only that the declaration was
 * checked. Here the declaration says 1 byte and the socket delivers 26 MiB.
 */
describe("S9 — the ceiling holds whatever the request declared", () => {
  const route = ROUTES[0];

  it("refuses an understated Content-Length at the streamed ceiling", async () => {
    const attempt = await call(route, await oversize(), {
      cookie: SESSION,
      contentLength: "1",
    });
    expect(attempt.response.status).toBe(413);
    expect(attempt.body.error).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      message: route.tooLargeMessage,
    });
    // Stopped mid-stream rather than after buffering the lot.
    expect(attempt.meter.pulled()).toBeLessThan((await oversize()).bytes.length);
    expect(attempt.meter.pulled()).toBeLessThanOrEqual(ATTACHMENT_CEILING + 2 * 64 * 1024);
  });

  it("treats a negative or unparseable Content-Length as no declaration", async () => {
    // Not rejected as oversize, not trusted as a bound: a valid body still works.
    const ok = await call(route, await validBody(route), {
      cookie: SESSION,
      contentLength: "-5",
    });
    expect(ok.response.status).toBe(201);

    // And the same nonsense declaration cannot smuggle an oversize body past.
    const refused = await call(route, await oversize(), {
      cookie: SESSION,
      contentLength: "-5",
    });
    expect(refused.response.status).toBe(413);
  });

  it("refuses an oversize body that declares two conflicting lengths", async () => {
    const attempt = await call(route, await oversize(), {
      cookie: SESSION,
      contentLength: "12, 34",
    });
    expect(attempt.response.status).toBe(413);
    expect(attempt.meter.pulled()).toBeLessThanOrEqual(ATTACHMENT_CEILING + 2 * 64 * 1024);
  });
});

/**
 * S10 — A CHUNKED BODY IS BOUNDED, AND THE BOUND IS MEASURED IN BYTES.
 *
 * No `Content-Length` at all is what `Transfer-Encoding: chunked` looks like from
 * inside the handler, and it is the case a header check cannot see. The peak is
 * asserted, not asserted-about: the ceiling, the chunk that crossed it, and one
 * more for the reader in flight.
 */
describe("S10 — chunked oversize: 413 with bounded memory", () => {
  it("refuses without buffering the whole body", async () => {
    const route = ROUTES[0];
    const body = await oversize();
    const attempt = await call(route, body, { cookie: SESSION, chunkSize: 128 * 1024 });

    expect(attempt.response.status).toBe(413);
    expect(attempt.response.headers.get("cache-control")).toBe("no-store");
    // It did read — this is the streaming ceiling, not the header one.
    expect(attempt.meter.reads()).toBeGreaterThan(0);
    expect(attempt.meter.pulled()).toBeLessThanOrEqual(ATTACHMENT_CEILING + 2 * 128 * 1024);
    expect(body.bytes.length - attempt.meter.pulled()).toBeGreaterThan(0);
    expect(state.calls.filter((c) => c !== "ensureWorkerReady")).toEqual([]);
  });
});

/**
 * S11 — SUB-LIMIT ANONYMOUS TRAFFIC COSTS NO BYTES.
 *
 * "Bounded" is not only the limiter: the reason a flood under the limit is
 * survivable is that each refusal reads nothing. Ten 8 MiB bodies, 80 MiB
 * offered, zero bytes accepted.
 */
describe("S11 — anonymous traffic below the limit is still bounded", () => {
  it("reads none of ten 8 MiB anonymous bodies", async () => {
    const route = ROUTES[0];
    const body = await multipartBody({
      organizationId: "org-1",
      file: file(Buffer.alloc(8 * MiB, 0x41), "eight.pdf"),
    });
    let totalPulled = 0;
    for (let i = 0; i < 10; i += 1) {
      const attempt = await call(route, body);
      expect(attempt.response.status, `attempt ${i}`).toBe(401);
      totalPulled += attempt.meter.pulled();
    }
    expect(totalPulled).toBe(0);
    expect(state.calls).toEqual([]);
  });
});

/**
 * S12 — THE ORDINARY UPLOAD STILL WORKS, WITH THE RIGHT BYTES.
 *
 * Everything above is a refusal. This is the one that says the boundary did not
 * simply break uploading: the bytes that reach storage are compared byte for
 * byte, not merely counted.
 */
describe("S12 — an authenticated upload completes with the exact bytes", () => {
  const PAYLOAD = Buffer.concat([PDF, Buffer.alloc(4096, 0x5a)]);

  it("documents/upload stores the bytes and records one audit line", async () => {
    const attempt = await call(ROUTES[1], await multipartBody({ file: file(PAYLOAD) }), {
      cookie: SESSION,
    });
    expect(attempt.response.status).toBe(201);
    expect(state.uploadedBytes?.equals(PAYLOAD)).toBe(true);
    expect(state.calls).toEqual(["ensureWorkerReady", "uploadToWorkspace", "audit.record"]);
    expect(state.auditMetadata).toEqual({ documentName: "document.pdf" });
  });

  it("versions/upload authorizes the destination before storing the bytes", async () => {
    const attempt = await call(
      ROUTES[2],
      await multipartBody({ expectedRevision: "3", file: file(PAYLOAD) }),
      { cookie: SESSION },
    );
    expect(attempt.response.status).toBe(201);
    expect(state.uploadedBytes?.equals(PAYLOAD)).toBe(true);
    // The pre-existing ordering invariant, unchanged by the gate.
    expect(state.calls).toEqual([
      "validateDestination",
      "upload",
      "createVersion",
      "audit.record",
    ]);
  });

  it("attachments stores the bytes it was sent", async () => {
    const attempt = await call(
      ROUTES[0],
      await multipartBody({ organizationId: "org-1", file: file(PAYLOAD, "notes.pdf") }),
      { cookie: SESSION },
    );
    expect(attempt.response.status).toBe(201);
    expect(state.attachmentData?.equals(PAYLOAD)).toBe(true);
    expect(state.calls).toEqual(["createAttachment"]);
  });
});

const PROXY_SECRET = "proxy-secret-0123456789";

/**
 * S13 — THE LIMIT WORKS IN BOTH SUPPORTED TOPOLOGIES.
 *
 * Direct-origin (no proxy, the shape this repository actually ships) and
 * behind-a-trusted-proxy (the shape a deployment adds). The two differ only in
 * whether a forwarded address is admissible as a key, and neither can be turned
 * off by the caller.
 */
describe("S13 — topology", () => {
  const route = ROUTES[0];

  it("direct origin: forwarding headers are not keys, so rotation cannot escape", async () => {
    env.UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN = "2";
    _resetConfigForTests();
    _resetUploadLimitsForTests();
    const body = await validBody(route);

    const statuses = [];
    for (const address of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
      const attempt = await call(route, body, { headers: { "x-forwarded-for": address } });
      statuses.push(attempt.response.status);
    }
    // Three different claimed clients, one bucket: the third is refused.
    expect(statuses).toEqual([401, 401, 429]);
  });

  it("behind a trusted proxy: each forwarded client gets its own bucket", async () => {
    env.TRUSTED_PROXY_SECRET = PROXY_SECRET;
    env.UPLOAD_ANON_RATE_LIMIT_PER_MIN = "1";
    env.UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN = "100";
    _resetConfigForTests();
    _resetUploadLimitsForTests();
    const body = await validBody(route);
    const fromProxy = (address: string) => ({
      headers: { [PROXY_SECRET_HEADER]: PROXY_SECRET, "x-forwarded-for": address },
    });

    expect((await call(route, body, fromProxy("1.1.1.1"))).response.status).toBe(401);
    // Same client again: its own budget is spent.
    const second = await call(route, body, fromProxy("1.1.1.1"));
    expect(second.response.status).toBe(429);
    expect(second.meter.reads()).toBe(0);
    // A different client is unaffected — the point of having a per-client bucket.
    expect((await call(route, body, fromProxy("9.9.9.9"))).response.status).toBe(401);
  });

  it("an authenticated user is keyed by session, not by network path", async () => {
    env.UPLOAD_RATE_LIMIT_PER_MIN = "1";
    _resetConfigForTests();
    _resetUploadLimitsForTests();
    const body = await validBody(route);

    expect(
      (await call(route, body, { cookie: SESSION, headers: { "x-forwarded-for": "1.1.1.1" } }))
        .response.status,
    ).toBe(201);
    // A new claimed address does not buy the same user a second budget.
    const second = await call(route, body, {
      cookie: SESSION,
      headers: { "x-forwarded-for": "2.2.2.2" },
    });
    expect(second.response.status).toBe(429);
    expect(second.meter.reads()).toBe(0);
  });
});

/**
 * S14 — A SPOOFED FORWARDING HEADER IS WORTH NOTHING.
 *
 * The property the brief names twice: `X-Forwarded-For` is not trusted unless it
 * arrived through the configured trusted proxy chain, and rotating it cannot
 * escape the limit.
 */
describe("S14 — forwarding-header spoof resistance", () => {
  const route = ROUTES[0];

  it("ignores forwarding headers presented with the WRONG proxy secret", async () => {
    env.TRUSTED_PROXY_SECRET = PROXY_SECRET;
    env.UPLOAD_ANON_RATE_LIMIT_PER_MIN = "50";
    env.UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN = "2";
    _resetConfigForTests();
    _resetUploadLimitsForTests();
    const body = await validBody(route);

    const statuses = [];
    for (const address of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
      const attempt = await call(route, body, {
        headers: { [PROXY_SECRET_HEADER]: "not-the-secret-0123", "x-forwarded-for": address },
      });
      statuses.push(attempt.response.status);
    }
    // The per-client bucket has 50 left; the caller still hits the global 2,
    // because a wrong secret means the address was never a key at all.
    expect(statuses).toEqual([401, 401, 429]);
  });

  it("ignores every forwarding header shape when no proxy is configured", async () => {
    env.UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN = "2";
    _resetConfigForTests();
    _resetUploadLimitsForTests();
    const body = await validBody(route);

    const statuses = [];
    const shapes: Record<string, string>[] = [
      { "x-forwarded-for": "1.1.1.1" },
      { "x-real-ip": "2.2.2.2" },
      { "x-forwarded-for": "3.3.3.3, 4.4.4.4", "x-real-ip": "5.5.5.5" },
    ];
    for (const headers of shapes) {
      statuses.push((await call(route, body, { headers })).response.status);
    }
    expect(statuses).toEqual([401, 401, 429]);
  });

  // The case the two above cannot see, and the harm that makes it matter: if a
  // forged header created a per-client bucket, an attacker could spend SOMEONE
  // ELSE's budget by writing their address into it, and the victim would be the
  // one refused. So an untrusted forwarding header must create no bucket at all —
  // not a rotating one, not a shared one. Mutation H (trust X-Forwarded-For with
  // no secret configured) passed the whole boundary suite without this case,
  // because the global ceiling was still charged and hid it.
  it("cannot spend a per-client budget it has no right to name", async () => {
    env.UPLOAD_ANON_RATE_LIMIT_PER_MIN = "1";
    env.UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN = "100";
    _resetConfigForTests();
    _resetUploadLimitsForTests();
    const body = await validBody(route);

    const statuses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push(
        (await call(route, body, { headers: { "x-forwarded-for": "9.9.9.9" } })).response.status,
      );
    }
    // A trusted deployment would refuse the second of these on the per-client
    // bucket. Untrusted, the header is not a key, so all three are the ordinary
    // anonymous refusal and nobody's budget moved.
    expect(statuses).toEqual([401, 401, 401]);
  });
});

/**
 * S15 — AUTHORIZATION IS NOT WEAKENED, AND NOTHING NEW IS DISCLOSED.
 *
 * Moving authentication ahead of the parse is only safe if it changes WHEN a
 * caller is refused and not WHAT it learns. The pair of comparisons below is the
 * whole invariant: an anonymous caller cannot tell a real Workspace from an
 * invented one, and a signed-in caller cannot tell a foreign organization from
 * one that does not exist.
 */
describe("S15 — authorization regression, with indistinguishable responses", () => {
  const route = ROUTES[0];

  it("answers an anonymous caller identically for a real and an invented workspace", async () => {
    const body = await validBody(route);
    const real = await call(route, body);
    const invented = await call(
      { ...route, path: `/api/workspaces/ws-does-not-exist/documents/doc-nope/attachments` },
      body,
    );

    const shape = (a: typeof real) => ({
      status: a.response.status,
      code: a.body.error?.code,
      message: a.body.error?.message,
      cache: a.response.headers.get("cache-control"),
      reads: a.meter.reads(),
      calls: [...state.calls],
    });
    expect(shape(invented)).toEqual(shape(real));
    expect(shape(real).status).toBe(401);
    // Nothing was looked up in either case, which is WHY they are identical.
    expect(state.calls).toEqual([]);
  });

  it("answers a foreign organization identically to one that does not exist", async () => {
    const foreign = await call(
      route,
      await multipartBody({ organizationId: "org-someone-else", file: file(PDF) }),
      { cookie: SESSION },
    );
    expect(foreign.response.status).toBe(403);
    expect(foreign.body.error).toMatchObject({
      code: "FORBIDDEN",
      message: "Organization access is not permitted.",
    });

    // Same request, but the user belongs to no organization at all.
    state.orgs = [];
    const missing = await call(
      route,
      await multipartBody({ organizationId: "org-someone-else", file: file(PDF) }),
      { cookie: SESSION },
    );
    expect(missing.response.status).toBe(foreign.response.status);
    expect(missing.body.error?.code).toBe(foreign.body.error?.code);
    expect(missing.body.error?.message).toBe(foreign.body.error?.message);
    expect(state.calls.filter((c) => c !== "ensureWorkerReady")).toEqual([]);
  });

  it("still refuses a member with no role in the named organization", async () => {
    state.role = null;
    const attempt = await call(
      route,
      await multipartBody({ organizationId: "org-1", file: file(PDF) }),
      { cookie: SESSION },
    );
    expect(attempt.response.status).toBe(403);
    expect(attempt.body.error?.code).toBe("FORBIDDEN");
    expect(state.attachmentData).toBeNull();
  });

  it("still refuses a version whose destination is unusable, before storing", async () => {
    state.destinationOk = false;
    const attempt = await call(
      ROUTES[2],
      await multipartBody({ expectedRevision: "3", file: file(PDF) }),
      { cookie: SESSION },
    );
    expect(attempt.response.status).toBe(422);
    expect(attempt.body.error?.message).toBe("This destination cannot be used.");
    expect(state.calls).toEqual(["validateDestination"]);
    expect(state.uploadedBytes).toBeNull();
  });
});

/**
 * S16 — NOTHING SENSITIVE LEAVES THE BOUNDARY.
 *
 * Every string below is a plant: a filename, a form value and a run of body text
 * that no log line, no error response and no limit key may contain. The 401, 400
 * and 429 paths are checked as well as the 201, because a refusal is the path most
 * likely to want to explain itself with the caller's own data.
 */
describe("S16 — privacy of logs, keys and errors", () => {
  const SECRETS = ["PATIENT-Ω-CONTRACT.pdf", "top-secret-field-value", "CONFIDENTIAL-BODY-TEXT"];

  async function plantedBody() {
    return multipartBody({
      organizationId: "org-1",
      name: "top-secret-field-value",
      file: file(
        Buffer.concat([PDF, Buffer.from("CONFIDENTIAL-BODY-TEXT")]),
        "PATIENT-Ω-CONTRACT.pdf",
      ),
    });
  }

  it("keeps planted strings out of logs and out of every refusal body", async () => {
    const console_ = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      env.UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN = "1";
      _resetConfigForTests();
      _resetUploadLimitsForTests();
      const route = ROUTES[0];
      const body = await plantedBody();

      // Refusal bodies only. The 201 is exercised too — its logs are checked
      // below — but its payload is the resource the caller just created, and an
      // attachment's own name coming back to its own uploader is the pre-existing
      // contract the client renders, not a disclosure.
      const texts: string[] = [];
      const accepted = await call(route, body, { cookie: SESSION });
      expect(accepted.response.status).toBe(201);
      const anonymous = await call(route, body);
      expect(anonymous.response.status).toBe(401);
      texts.push(JSON.stringify(anonymous.body));
      const limited = await call(route, body);
      expect(limited.response.status).toBe(429);
      texts.push(JSON.stringify(limited.body));
      const malformed = await call(route, hostileFilenameBody(), { cookie: SESSION });
      expect(malformed.response.status).toBe(400);
      texts.push(JSON.stringify(malformed.body));

      const logged = [
        ...state.logs,
        ...console_.mock.calls.flat().map(String),
        ...warn.mock.calls.flat().map(String),
        ...error.mock.calls.flat().map(String),
        ...info.mock.calls.flat().map(String),
      ].join("\n");
      for (const secret of SECRETS) {
        expect(logged, `logged: ${secret}`).not.toContain(secret);
        for (const text of texts) expect(text, `response: ${secret}`).not.toContain(secret);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("records only the audited name in the audit line, never field or body content", async () => {
    await call(ROUTES[1], await plantedBody(), { cookie: SESSION });
    // `documentName` is the document's own name as the service resolved it — the
    // pre-existing activity-feed contract. No form values, no page text, and in
    // particular not the uploaded filename passed off as the document's name.
    expect(state.auditMetadata).toEqual({ documentName: "document.pdf" });
  });

  it("keys the limit on identity alone, so the body cannot change the bucket", async () => {
    env.UPLOAD_RATE_LIMIT_PER_MIN = "1";
    _resetConfigForTests();
    _resetUploadLimitsForTests();
    const route = ROUTES[0];

    expect((await call(route, await validBody(route), { cookie: SESSION })).response.status).toBe(
      201,
    );
    // A completely different filename, fields and byte content: same user, so the
    // same bucket. A key built from anything in the body would let this through.
    const second = await call(route, await plantedBody(), { cookie: SESSION });
    expect(second.response.status).toBe(429);
    expect(Object.keys(second.body.error ?? {}).sort()).toEqual(["code", "message", "requestId"]);
  });
});

/**
 * S17 — EVERY ONE OF THE FIVE CALL SITES SURVIVES A PARSER EXCEPTION.
 *
 * The malformed-body 500 was a real defect at two of these five sites, and it was
 * reachable with nothing more than a `"` in a filename. This is the site-by-site
 * proof that the exception is now the client's error everywhere.
 */
describe("S17 — parser exception coverage at all five call sites", () => {
  it.each(ROUTES)("$name: 400 rather than 500", async (route) => {
    const attempt = await call(route, hostileFilenameBody(), { cookie: SESSION });
    expect(attempt.response.status).toBe(400);
    expect(attempt.body.error?.code).toBe("MALFORMED_MULTIPART");
  });

  it("toolJobSubmit and processingJobSubmit throw the shared error, mapped to 400", async () => {
    const { submitToolJob } = await import("@/lib/server/toolJobSubmit");
    const { submitProcessingJob } = await import("@/lib/server/processingJobSubmit");
    const malformed = () => {
      const { bytes, contentType } = hostileFilenameBody();
      return new Request("http://localhost:3000/api/tools/merge-pdf", {
        method: "POST",
        headers: { "content-type": contentType },
        body: new Uint8Array(bytes),
      });
    };
    const config = { options: [] } as never;
    const actor = { ownerType: "anon", ownerId: "anon" } as never;

    for (const submit of [submitToolJob, submitProcessingJob]) {
      await expect(
        submit({ slug: "merge-pdf", config, request: malformed(), actor }),
      ).rejects.toBeInstanceOf(MalformedMultipartError);
    }

    // What both tool routes do with it, in the flat envelope those routes use.
    const mapped = multipartToolResponse(new MalformedMultipartError())!;
    expect(mapped.status).toBe(400);
    expect(mapped.headers.get("cache-control")).toBe("no-store");
    expect(await mapped.json()).toEqual({ error: "Malformed multipart body." });
    expect(multipartFailure(new MultipartTooLargeError())).toMatchObject({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
    // Not ours: the caller must rethrow rather than answer 400 for anything else.
    expect(multipartFailure(new TypeError("something else"))).toBeNull();
  });

  it("still parses a hostile-but-legal filename rather than refusing it", async () => {
    // Spec-encoded quotes are LEGAL and must survive: the fix is about unreadable
    // bodies, not about filenames with punctuation in them.
    const boundary = "----pdfdadiLegal";
    const hostile = 'a";b.pdf';
    const body = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${hostile.replace(/"/g, "%22")}"\r\n` +
        `Content-Type: application/pdf\r\n\r\n` +
        `%PDF-1.7\n%%EOF\n\r\n--${boundary}--\r\n`,
      "utf8",
    );
    const request = new NextRequest(`${ORIGIN}/api/tools/merge-pdf`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: new Uint8Array(body),
    } as never);
    const form = await readMultipart(request, 10 * MiB);
    expect((form.get("file") as File).name).toBe(hostile);
  });
});

/**
 * S18 — THE EXACT RESPONSE MATRIX.
 *
 * One row per outcome the boundary can produce, on one route, with the header
 * behaviour spelled out. This is the table the closeout documents quote, so it is
 * asserted rather than described — including the two rows where `Cache-Control` is
 * absent, which are the ones the gate does not build.
 */
describe("S18 — response matrix (attachments)", () => {
  interface Row {
    scenario: string;
    status: number;
    code: string | null;
    message: string | null;
    cacheControl: string | null;
    retryAfter: boolean;
    run: () => Promise<Awaited<ReturnType<typeof call>>>;
  }

  const route = ROUTES[0];
  const rows: Row[] = [
    {
      scenario: "foreign origin",
      status: 403,
      code: "CSRF_ORIGIN_REJECTED",
      message: "Request origin is not allowed.",
      cacheControl: "no-store",
      retryAfter: false,
      run: async () =>
        call(route, await validBody(route), { cookie: SESSION, origin: "https://evil.example" }),
    },
    {
      scenario: "no origin evidence",
      status: 403,
      code: "CSRF_ORIGIN_REQUIRED",
      message: "A same-origin request is required.",
      cacheControl: "no-store",
      retryAfter: false,
      run: async () => call(route, await validBody(route), { cookie: SESSION, origin: null }),
    },
    {
      scenario: "declared oversize",
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "This attachment is too large.",
      cacheControl: "no-store",
      retryAfter: false,
      run: async () =>
        call(route, await validBody(route), { cookie: SESSION, contentLength: String(200 * MiB) }),
    },
    {
      scenario: "streamed oversize (no declared length)",
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "This attachment is too large.",
      cacheControl: "no-store",
      retryAfter: false,
      run: async () => call(route, await oversize(), { cookie: SESSION }),
    },
    {
      scenario: "wrong media type",
      status: 415,
      code: "INVALID_INPUT",
      message: "Expected a multipart/form-data upload.",
      cacheControl: "no-store",
      retryAfter: false,
      run: async () =>
        call(
          route,
          { bytes: Buffer.from("{}"), contentType: "application/json" },
          { cookie: SESSION },
        ),
    },
    {
      scenario: "anonymous",
      status: 401,
      code: "UNAUTHORIZED",
      message: "Authentication is required.",
      cacheControl: "no-store",
      retryAfter: false,
      run: async () => call(route, await validBody(route)),
    },
    {
      scenario: "rate limited",
      status: 429,
      code: "RATE_LIMITED",
      message: "Too many uploads. Please wait and try again.",
      cacheControl: "no-store",
      retryAfter: true,
      run: async () => {
        env.UPLOAD_RATE_LIMIT_PER_MIN = "1";
        _resetConfigForTests();
        _resetUploadLimitsForTests();
        await call(route, await validBody(route), { cookie: SESSION });
        return call(route, await validBody(route), { cookie: SESSION });
      },
    },
    {
      scenario: "malformed multipart",
      status: 400,
      code: "MALFORMED_MULTIPART",
      message: "Malformed multipart body.",
      cacheControl: "no-store",
      retryAfter: false,
      run: async () => call(route, hostileFilenameBody(), { cookie: SESSION }),
    },
    {
      // Post-parse, returned by the ROUTE rather than the gate: no explicit
      // `Cache-Control`, which is safe because 422 is not cacheable by default
      // (RFC 9111 §3) — recorded as it is rather than tidied.
      scenario: "well-formed body, invalid fields",
      status: 422,
      code: "INVALID_INPUT",
      message: "Invalid attachment fields.",
      cacheControl: null,
      retryAfter: false,
      run: async () => call(route, await multipartBody({ file: file(PDF) }), { cookie: SESSION }),
    },
    {
      scenario: "accepted",
      status: 201,
      code: null,
      message: null,
      cacheControl: null,
      retryAfter: false,
      run: async () => call(route, await validBody(route), { cookie: SESSION }),
    },
  ];

  it.each(rows)("$scenario -> $status", async (row) => {
    const attempt = await row.run();
    expect(attempt.response.status).toBe(row.status);
    if (row.code) {
      expect(attempt.body.error?.code).toBe(row.code);
      expect(attempt.body.error?.message).toBe(row.message);
    } else {
      expect(attempt.body.error).toBeUndefined();
    }
    expect(attempt.response.headers.get("cache-control")).toBe(row.cacheControl);
    const retryAfter = attempt.response.headers.get("retry-after");
    if (row.retryAfter) {
      expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
      // 61, not 60, is the honest ceiling: the window is 60s and the header adds
      // one millisecond so a client that obeys it to the millisecond is not
      // refused again. Refusing on the same millisecond as the first request is
      // the case that produces it, and it is reachable — this assertion failed at
      // 60 on a run where both requests landed inside one millisecond.
      expect(Number(retryAfter)).toBeLessThanOrEqual(61);
    } else {
      expect(retryAfter).toBeNull();
    }
  });

  it("refuses before reading the body in every pre-parse row", async () => {
    // The four rows the gate answers without a parse, and the two it cannot.
    const preParse = ["foreign origin", "no origin evidence", "declared oversize", "wrong media type", "anonymous"];
    for (const scenario of rows.filter((r) => preParse.includes(r.scenario))) {
      state.calls = [];
      _resetUploadLimitsForTests();
      const attempt = await scenario.run();
      expect(attempt.meter.reads(), scenario.scenario).toBe(0);
      expect(attempt.bodyLocked, scenario.scenario).toBe(false);
    }
  });
});
